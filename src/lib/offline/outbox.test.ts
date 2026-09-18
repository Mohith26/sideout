import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "@/lib/api-client";
import { enqueueScore, IndexedDbOutbox, isTransient, listQueued, MemoryOutbox, replayOutbox, scorePath, type OutboxItem, type OutboxStore } from "@/lib/offline/outbox";

const SETS = [
  { setNumber: 1, usPoints: 21, themPoints: 18 },
  { setNumber: 2, usPoints: 21, themPoints: 16 },
];

const ok = (): ApiResult<unknown> => ({ ok: true, data: { outcome: "awaiting_second" }, status: 201, retryAfterMs: null });
const transport = (): ApiResult<unknown> => ({ ok: false, error: { code: "unavailable", message: "Could not reach Sideout." }, status: 0, retryAfterMs: null });
const refused = (code: string, message: string, status = 409): ApiResult<unknown> => ({ ok: false, error: { code: "conflict", message, detail: { code } }, status, retryAfterMs: null });

async function seeded(store: OutboxStore): Promise<OutboxItem[]> {
  const a = await enqueueScore(store, { matchId: "m1", sets: SETS, now: 1000 });
  const b = await enqueueScore(store, { matchId: "m2", sets: SETS, now: 2000 });
  return [a, b];
}

/** Every store the queue can sit on behaves the same; IndexedDB is the one the browser uses. */
const stores: Array<[string, () => OutboxStore]> = [
  ["MemoryOutbox", () => new MemoryOutbox()],
  ["IndexedDbOutbox", () => new IndexedDbOutbox(new IDBFactory())],
];

describe.each(stores)("outbox on %s", (_name, make) => {
  it("queues a submission exactly as it will go over the wire, one per match, newest replacing older", async () => {
    const store = make();
    const first = await enqueueScore(store, { matchId: "m1", sets: SETS, now: 1000 });
    expect(first).toMatchObject({ matchId: "m1", path: scorePath("m1"), body: { sets: SETS }, status: "queued", attempts: 0, lastError: null, createdAt: 1000 });
    const replaced = await enqueueScore(store, { matchId: "m1", sets: [{ setNumber: 1, usPoints: 21, themPoints: 10 }], now: 1500 });
    const items = await listQueued(store);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(replaced.id);
    expect(items[0]?.body.sets).toEqual([{ setNumber: 1, usPoints: 21, themPoints: 10 }]);
  });

  it("survives a fresh handle on the same database, in creation order", async () => {
    const factory = new IDBFactory();
    const a = _name === "IndexedDbOutbox" ? new IndexedDbOutbox(factory) : make();
    await seeded(a);
    const b = _name === "IndexedDbOutbox" ? new IndexedDbOutbox(factory) : a;
    expect((await listQueued(b)).map((i) => i.matchId)).toEqual(["m1", "m2"]);
  });

  it("replays in order through the real send, removing what landed", async () => {
    const store = make();
    await seeded(store);
    const send = vi.fn(async () => ok());
    const report = await replayOutbox(store, send, () => 5000);
    expect(send.mock.calls.map((c) => (c as unknown as [OutboxItem])[0].matchId)).toEqual(["m1", "m2"]);
    expect(send.mock.calls.map((c) => (c as unknown as [OutboxItem])[0].path)).toEqual([scorePath("m1"), scorePath("m2")]);
    expect(report.outcomes.map((o) => o.result)).toEqual(["sent", "sent"]);
    expect(report.pending).toBe(false);
    expect(await listQueued(store)).toEqual([]);
  });

  it("stops at the first transient failure and keeps everything queued for the next reconnect", async () => {
    const store = make();
    await seeded(store);
    const send = vi.fn(async () => transport());
    const report = await replayOutbox(store, send, () => 5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(report.outcomes.map((o) => o.result)).toEqual(["deferred", "deferred"]);
    expect(report.pending).toBe(true);
    const items = await listQueued(store);
    expect(items.map((i) => [i.status, i.attempts])).toEqual([
      ["queued", 1],
      ["queued", 0],
    ]);
    expect(items[0]?.lastError).toEqual({ code: "unavailable", message: "Could not reach Sideout.", at: 5000 });
    // A thrown send counts as transient too.
    const thrown = await replayOutbox(store, async () => Promise.reject(new Error("socket hung up")), () => 6000);
    expect(thrown.pending).toBe(true);
    expect((await listQueued(store))[0]?.lastError?.message).toBe("socket hung up");
  });

  it("marks a definitive refusal failed for the player to read, drops one the match no longer takes, and carries on", async () => {
    const store = make();
    await seeded(store);
    await enqueueScore(store, { matchId: "m3", sets: SETS, now: 3000 });
    const send = vi.fn(async (item: OutboxItem) => {
      if (item.matchId === "m1") return refused("illegal_scoreline", "Set 1: 21–18 is fine but set 2 is not finished.", 422);
      if (item.matchId === "m2") return refused("match_not_open", "The match is final.");
      return ok();
    });
    const report = await replayOutbox(store, send, () => 7000);
    expect(report.outcomes.map((o) => o.result)).toEqual(["failed", "settled_elsewhere", "sent"]);
    expect(report.pending).toBe(false);
    const items = await listQueued(store);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ matchId: "m1", status: "failed", attempts: 1, lastError: { code: "illegal_scoreline", at: 7000 } });
    // A failed item is never retried; only discarding it clears it.
    const again = await replayOutbox(store, send, () => 8000);
    expect(again.outcomes).toEqual([]);
    await store.remove(items[0]?.id ?? "");
    expect(await listQueued(store)).toEqual([]);
  });
});

describe("isTransient", () => {
  it("treats no connection, a server error and a rate limit as worth retrying, and everything else as an answer", () => {
    expect(isTransient(transport())).toBe(true);
    expect(isTransient({ ok: false, error: { code: "internal", message: "x" }, status: 502, retryAfterMs: null })).toBe(true);
    expect(isTransient({ ok: false, error: { code: "rate_limited", message: "x" }, status: 429, retryAfterMs: 1000 })).toBe(true);
    expect(isTransient(refused("illegal_scoreline", "x", 422))).toBe(false);
    expect(isTransient({ ok: false, error: { code: "unauthorized", message: "x" }, status: 401, retryAfterMs: null })).toBe(false);
    expect(isTransient(ok())).toBe(false);
  });
});
