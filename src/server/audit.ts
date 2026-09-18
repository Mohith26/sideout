import "server-only";
import { auditLog, type ActorKind, type NewAuditLogEntry } from "@/db/schema";
import type { Db } from "@/db/connection";
import type { TransitionActor } from "@/domain/transitions";
import { uuidv7 } from "@/lib/uuid";

/**
 * `audit_log` writer (spec §6.5). Every state transition on a tournament,
 * match, or consensus record goes through here, inside the same transaction
 * as the row it describes. `detail` is serialized as-is; keep it to ids,
 * enums and numbers — never a phone number, code or secret.
 */

/** What a service needs from either the database or an open transaction. */
export type Tx = Pick<Db, "select" | "insert" | "update" | "delete">;

export interface AuditInput {
  actor: TransitionActor;
  action: string;
  subjectType: "tournament" | "match" | "team" | "user" | "donation" | "consensus";
  subjectId: string;
  detail?: Record<string, unknown> | undefined;
  at: number;
}

export function writeAudit(tx: Tx, input: AuditInput): NewAuditLogEntry {
  const row: NewAuditLogEntry = {
    id: uuidv7(),
    actorUserId: input.actor.userId,
    actorKind: input.actor.kind,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    detailJson: input.detail === undefined ? null : JSON.stringify(input.detail),
    createdAt: input.at,
  };
  tx.insert(auditLog).values(row).run();
  return row;
}

export const SYSTEM_ACTOR: TransitionActor = { kind: "system", userId: null };

export function actorFor(kind: ActorKind, userId: string | null): TransitionActor {
  return { kind, userId };
}
