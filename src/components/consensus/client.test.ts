import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "@/components/consensus/client";

const reply = (body: string, init: ResponseInit = {}) => vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init }));

describe("postJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the envelope the server sent, whichever way it went", async () => {
    vi.stubGlobal("fetch", reply(JSON.stringify({ ok: true, data: { id: "m1" } })));
    expect(await postJson("/api/matches/m1/scores", { sets: [] })).toEqual({ ok: true, data: { id: "m1" } });

    vi.stubGlobal("fetch", reply(JSON.stringify({ ok: false, error: { code: "conflict", message: "Already submitted.", detail: { code: "already_submitted_by_team" } } }), { status: 409 }));
    expect(await postJson("/api/matches/m1/scores", { sets: [] })).toEqual({ ok: false, error: { code: "conflict", message: "Already submitted.", detail: { code: "already_submitted_by_team" } } });
  });

  it("says nothing was sent only when the request never left", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const res = await postJson("/api/matches/m1/scores", { sets: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("unavailable");
    expect(res.error.message).toMatch(/was not sent/);
  });

  it("reports a reply that is not the envelope without claiming the request was not sent", async () => {
    const gateway = "<html><body><h1>504 Gateway Time-out</h1></body></html>";
    vi.stubGlobal("fetch", reply(gateway, { status: 504, headers: { "content-type": "text/html" } }));
    const timedOut = await postJson("/api/matches/m1/scores", { sets: [] });
    expect(timedOut.ok).toBe(false);
    if (timedOut.ok) return;
    expect(timedOut.error.code).toBe("unavailable");
    expect(timedOut.error.message).not.toMatch(/not sent/);
    expect(timedOut.error.message).toMatch(/unexpected reply/);

    for (const body of ["", '{"message":"not an envelope"}', "null"]) {
      vi.stubGlobal("fetch", reply(body));
      const res = await postJson("/api/matches/m1/scores", { sets: [] });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatchObject({ code: "internal", message: expect.stringMatching(/unexpected reply/) });
    }
  });
});
