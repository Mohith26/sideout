import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { lucraLinks, type User } from "@/db/schema";
import { ApiFailure } from "@/lib/api";
import { systemClock, type Clock } from "@/lib/clock";
import { uuidFromSeed } from "@/lib/uuid";
import type { LucraAdapter, MockUser } from "@/lucra";
import { deliverPendingMockWebhooks } from "@/server/lucra-webhooks";
import { getLucra, mockLucraUserId } from "@/server/lucra";

/**
 * The server half of the browser stand-in for the Lucra Web SDK
 * (`src/lucra/sdk-mock.ts`), reachable only through
 * `POST /api/rest/_mock/sdk` — a `route.mock.ts` file that a non-mock build
 * does not contain. Where Lucra's iframe talks to Lucra's backend, the
 * stand-in talks to the in-process mock here, and the Sideout session stands
 * in for Lucra's own: every action is scoped to the signed-in caller's
 * account, never to a user named in the request.
 *
 * Every change the mock makes travels the production path: it emits the
 * documented webhook (`UserSignedUp`, `UserKYCVerified`, `FundsDeposited`,
 * `TournamentUserJoined`) and this module hands it to the app's receiver
 * before answering, so `lucra_links` changes only the way it would in
 * sandbox — by the receiver, keyed on Lucra's id.
 *
 * Failures are Sideout envelopes whose `detail.code` is one of the SDK's
 * `LucraApiErrorCode` values, which the stand-in turns back into a
 * `LucraApiError` so `LucraGate` branches on the same discriminant it would
 * in sandbox.
 */

export const SDK_ERROR_CODES = ["UNVERIFIED", "INSUFFICIENT_FUNDS", "DEMOGRAPHIC_INFORMATION_MISSING", "LOCATION_ERROR", "LOCATION_NEEDED", "API_ERROR"] as const;
export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

const cents = z.number().int().positive().max(1_000_000);

export const mockSdkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("session") }).strict(),
  z.object({ action: z.literal("login") }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
  z.object({ action: z.literal("userUpdated"), metadata: z.record(z.string(), z.string()).nullable() }).strict(),
  z.object({ action: z.literal("kyc") }).strict(),
  z.object({ action: z.literal("demographic") }).strict(),
  z.object({ action: z.literal("deposit"), amountCents: cents }).strict(),
  z.object({ action: z.literal("withdraw"), amountCents: cents }).strict(),
  z.object({ action: z.literal("join"), matchupId: z.string().min(1) }).strict(),
  z.object({ action: z.literal("tournament"), matchupId: z.string().min(1) }).strict(),
]);
export type MockSdkActionInput = z.infer<typeof mockSdkActionSchema>;

/** The SDK's `SDKLucraUser` for a mock account: the fields the SDK publishes, balance in dollars. */
export interface MockSdkUserView {
  id: string;
  username: string;
  balance: number;
  accountStatus: MockUser["accountStatus"];
  metadata: Record<string, string>;
}

export function sdkUserView(user: MockUser): MockSdkUserView {
  // The SDK's `SDKLucraUser.metadata` is string-valued; the mock stores the wider wire shape.
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(user.metadata)) if (typeof v === "string") metadata[k] = v;
  return { id: user.id, username: user.username, balance: user.balanceCents / 100, accountStatus: user.accountStatus, metadata };
}

function sdkFailure(code: SdkErrorCode, message: string): ApiFailure {
  return new ApiFailure("conflict", message, { code });
}

function requireMock(adapter: LucraAdapter) {
  const mock = adapter.mock;
  if (!mock) throw new Error("The mock SDK route exists only in mock mode.");
  return mock;
}

/** The caller's mock account, if they have signed in to the mock (by phone, the way Lucra identifies a sign-in). */
function accountFor(mock: ReturnType<typeof requireMock>, user: User): MockUser | undefined {
  if (!user.phoneE164) return undefined;
  return mock.findUserByPhone(user.phoneE164);
}

function requireAccount(mock: ReturnType<typeof requireMock>, user: User): MockUser {
  const account = accountFor(mock, user);
  if (!account) throw new ApiFailure("unauthorized", "Sign in to Lucra first.");
  return account;
}

export async function runMockSdkAction(user: User, input: MockSdkActionInput, clock: Clock = systemClock): Promise<Record<string, unknown>> {
  const adapter = getLucra();
  const mock = requireMock(adapter);
  switch (input.action) {
    case "session": {
      const account = accountFor(mock, user);
      return { action: "session", user: account ? sdkUserView(account) : null };
    }
    case "login": {
      if (!user.phoneE164) throw sdkFailure("API_ERROR", "This account has no phone number; Lucra signs users in by phone.");
      const link = getDb().select().from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
      const { user: account, created } = mock.signIn({
        // A seeded link already names its Lucra user; anyone else gets a stable id the read-back and webhooks will echo.
        id: link ? mockLucraUserId(link) : uuidFromSeed(`lucra-user:phone:${user.phoneE164}`),
        username: user.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "."),
        phoneNumber: user.phoneE164,
        ...(link ? { metadata: { externalId: link.externalId } } : {}),
      });
      if (created) await deliverPendingMockWebhooks(clock);
      return { action: "login", user: sdkUserView(account) };
    }
    case "logout":
      return { action: "logout" };
    case "userUpdated": {
      const account = requireAccount(mock, user);
      // The stand-in may only bind the caller's own external id to the caller's own account.
      const ext = input.metadata?.externalId;
      if (ext !== undefined) {
        const link = getDb().select().from(lucraLinks).where(eq(lucraLinks.userId, user.id)).get();
        if (!link || link.externalId !== ext) throw sdkFailure("API_ERROR", "That external id does not belong to this account.");
      }
      return { action: "userUpdated", user: sdkUserView(mock.setUserMetadata(account.id, input.metadata)) };
    }
    case "kyc": {
      const account = requireAccount(mock, user);
      const outcome = mock.verifyIdentity(account.id);
      await deliverPendingMockWebhooks(clock);
      return { action: "kyc", outcome, user: sdkUserView(account) };
    }
    case "demographic": {
      const account = requireAccount(mock, user);
      mock.completeDemographics(account.id);
      await deliverPendingMockWebhooks(clock);
      return { action: "demographic", user: sdkUserView(account) };
    }
    case "deposit": {
      const account = requireAccount(mock, user);
      if (account.accountStatus === "BLOCKED") throw sdkFailure("API_ERROR", "This account cannot add funds.");
      mock.deposit(account.id, input.amountCents);
      await deliverPendingMockWebhooks(clock);
      return { action: "deposit", user: sdkUserView(account) };
    }
    case "withdraw": {
      const account = requireAccount(mock, user);
      if (!mock.withdraw(account.id, input.amountCents)) throw sdkFailure("INSUFFICIENT_FUNDS", "The balance does not cover that withdrawal.");
      return { action: "withdraw", user: sdkUserView(account) };
    }
    case "join": {
      const account = requireAccount(mock, user);
      const matchup = mock.getMatchup(input.matchupId);
      if (!matchup || matchup.kind !== "pool_tournament") throw sdkFailure("API_ERROR", "No such tournament.");
      // The SDK's documented gates, in the order Lucra's join reports them.
      if (account.accountStatus === "BLOCKED") throw sdkFailure("API_ERROR", "This account is not in good standing.");
      if (!account.demographicsComplete) throw sdkFailure("DEMOGRAPHIC_INFORMATION_MISSING", "Lucra needs the demographic form before a free-to-play entry.");
      if (matchup.buyInAmount > 0 && account.accountStatus === "UNVERIFIED") throw sdkFailure("UNVERIFIED", "Identity verification is required before a paid entry.");
      if (matchup.buyInAmount > 0 && account.balanceCents < matchup.buyInAmount) throw sdkFailure("INSUFFICIENT_FUNDS", "The balance does not cover the buy-in.");
      if (matchup.status === "CLOSED" || matchup.status === "CANCELED") throw sdkFailure("API_ERROR", "This tournament is no longer open.");
      mock.join(matchup.id, account.id);
      await deliverPendingMockWebhooks(clock);
      return { action: "join", matchupId: matchup.id };
    }
    case "tournament": {
      const account = requireAccount(mock, user);
      const matchup = mock.getMatchup(input.matchupId);
      if (!matchup || matchup.kind !== "pool_tournament") throw sdkFailure("API_ERROR", "No such tournament.");
      const serialized = mock.serializeMatchup(matchup);
      const you = serialized.users.find((u) => u.userId === account.id) ?? null;
      return {
        action: "tournament",
        tournament: {
          matchupId: matchup.id,
          title: matchup.title,
          status: matchup.status,
          participants: matchup.participants.size,
          buyInCents: matchup.buyInAmount,
          rewards: serialized.rewardStructure.map((r) => ({ position: r.positionOverride ?? r.position, value: r.value, userName: r.userName ?? null })),
          you: you ? { score: you.score, position: you.position, attemptFinished: !you.canSubmitNewScore } : null,
        },
      };
    }
  }
}
