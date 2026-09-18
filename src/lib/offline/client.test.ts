// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discardQueued, OUTBOX_REPLAYED_EVENT, queueScore, subscribeOutbox, syncOutbox, useOutboxStoreForTests } from "@/lib/offline/client";
import { MemoryOutbox, type OutboxItem, type ReplayReport } from "@/lib/offline/outbox";

const SETS = [{ setNumber: 1, usPoints: 21, themPoints: 12 }];

describe("outbox client", () => {
  let store: MemoryOutbox;
  beforeEach(() => {
    store = new MemoryOutbox();
    useOutboxStoreForTests(store);
  });
  afterEach(() => {
    useOutboxStoreForTests(null);
  });

  it("tells subscribers the queue on subscribe and after every change", async () => {
    const seen: OutboxItem[][] = [];
    const unsubscribe = subscribeOutbox((items) => seen.push(items));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([]);
    const item = await queueScore("m1", SETS);
    expect(seen.at(-1)?.map((i) => i.id)).toEqual([item.id]);
    await discardQueued(item.id);
    expect(seen.at(-1)).toEqual([]);
    unsubscribe();
    await queueScore("m2", SETS);
    expect(seen.at(-1)).toEqual([]);
  });

  it("replays through one shared run and announces the report on window", async () => {
    await queueScore("m1", SETS);
    const events: ReplayReport[] = [];
    window.addEventListener(OUTBOX_REPLAYED_EVENT, (e) => events.push((e as CustomEvent<ReplayReport>).detail));
    let release: (() => void) | null = null;
    const send = vi.fn(
      () =>
        new Promise<{ ok: true; data: unknown; status: number; retryAfterMs: null }>((resolve) => {
          release = () => resolve({ ok: true, data: {}, status: 201, retryAfterMs: null });
        }),
    );
    const first = syncOutbox(send);
    const second = syncOutbox(send);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    const report = await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(report.outcomes.map((o) => o.result)).toEqual(["sent"]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.outcomes[0]?.item.matchId).toBe("m1");
    expect(await store.list()).toEqual([]);
    // A later sync is a new run; with nothing queued it announces nothing.
    const empty = await syncOutbox(send);
    expect(empty.outcomes).toEqual([]);
    expect(events).toHaveLength(1);
  });
});
