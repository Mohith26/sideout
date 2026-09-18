import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DemoAccounts } from "@/components/auth/DemoAccounts";
import { SignInForm } from "@/components/auth/SignInForm";
import { Container } from "@/components/shell/Container";
import { DatabaseNotReady } from "@/components/shell/DatabaseNotReady";
import { listDemoAccounts } from "@/db/queries/demo";
import { env } from "@/env";
import { loadAsync } from "@/lib/load";
import { safeNextPath } from "@/lib/redirects";
import { viewer } from "@/server/auth/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

/**
 * Phone sign-in (spec §11.4 needs a phone identity for invites). A signed-in
 * visitor is sent straight back to where they were going; `next` is only ever
 * honoured as a same-origin path. On the public demo (`DEMO_ACCOUNTS`) the
 * account picker sits above the phone form, which stays exactly as it is.
 */
export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  const { next } = await searchParams;
  const target = safeNextPath(next, "/me");
  const loaded = await loadAsync(() => viewer());
  if (!loaded.ok) return <DatabaseNotReady message={loaded.message} />;
  if (loaded.data) redirect(target);
  const demoAccounts = env.demoAccountsEnabled ? (listDemoAccounts() ?? []) : [];
  return (
    <Container className="py-6 md:py-8">
      <div className={demoAccounts.length ? "mx-auto max-w-2xl" : "mx-auto max-w-md"}>
        <h1 className="type-display-l">Sign in</h1>
        {demoAccounts.length ? (
          <>
            <DemoAccounts accounts={demoAccounts} next={target} className="mt-6" />
            <h2 className="type-heading mt-10">Sign in with your phone</h2>
            <p className="mt-2 text-text-secondary">Enter your phone number and we will text you a six-digit code. No password, no email.</p>
          </>
        ) : (
          <p className="mt-2 text-text-secondary">Enter your phone number and we will text you a six-digit code. No password, no email.</p>
        )}
        <SignInForm next={target} className="mt-6" />
      </div>
    </Container>
  );
}
