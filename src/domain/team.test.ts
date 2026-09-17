import { describe, expect, it } from "vitest";
import { assertTeamRoster, checkTeamRoster } from "@/domain/team";

describe("team roster", () => {
  it("accepts exactly one captain and one player", () => {
    expect(checkTeamRoster([{ userId: "u1", role: "captain" }, { userId: "u2", role: "player" }])).toEqual({ ok: true });
  });

  it("rejects wrong sizes, duplicates, and captain counts", () => {
    expect(checkTeamRoster([{ userId: "u1", role: "captain" }])).toMatchObject({ ok: false, reason: expect.stringContaining("exactly 2") });
    expect(
      checkTeamRoster([
        { userId: "u1", role: "captain" },
        { userId: "u2", role: "player" },
        { userId: "u3", role: "player" },
      ]),
    ).toMatchObject({ ok: false });
    expect(checkTeamRoster([{ userId: "u1", role: "captain" }, { userId: "u1", role: "player" }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("twice"),
    });
    expect(checkTeamRoster([{ userId: "u1", role: "player" }, { userId: "u2", role: "player" }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("captain"),
    });
    expect(() => assertTeamRoster([])).toThrow(/Invalid team roster/);
  });
});
