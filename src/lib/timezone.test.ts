import { describe, expect, it } from "vitest";
import { formatWallClock, isValidTimeZone, parseWallClock, wallClockAt, wallClockToEpoch, zoneOffsetAt } from "@/lib/timezone";

const LA = "America/Los_Angeles";

describe("timezone", () => {
  it("round-trips a wall clock through a zone", () => {
    const wall = { year: 2026, month: 9, day: 17, hour: 8, minute: 0 };
    const ms = wallClockToEpoch(wall, LA);
    // 08:00 PDT is 15:00 UTC.
    expect(new Date(ms).toISOString()).toBe("2026-09-17T15:00:00.000Z");
    expect(wallClockAt(ms, LA)).toEqual(wall);
    expect(formatWallClock(ms, LA)).toBe("2026-09-17T08:00");
    expect(zoneOffsetAt(ms, LA)).toBe(-7 * 3_600_000);
  });

  it("handles standard time and a zone east of UTC", () => {
    const winter = wallClockToEpoch({ year: 2026, month: 1, day: 10, hour: 9, minute: 30 }, LA);
    expect(new Date(winter).toISOString()).toBe("2026-01-10T17:30:00.000Z");
    const tokyo = wallClockToEpoch({ year: 2026, month: 1, day: 10, hour: 9, minute: 30 }, "Asia/Tokyo");
    expect(new Date(tokyo).toISOString()).toBe("2026-01-10T00:30:00.000Z");
    expect(formatWallClock(tokyo, "Asia/Tokyo")).toBe("2026-01-10T09:30");
  });

  it("resolves a wall time inside a DST gap to the later instant", () => {
    // 2026-03-08 02:30 does not exist in Los Angeles; 03:30 PDT does.
    const ms = wallClockToEpoch({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, LA);
    expect(wallClockAt(ms, LA)).toEqual({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 });
  });

  it("parses datetime-local values and rejects nonsense", () => {
    expect(parseWallClock("2026-09-17T08:00")).toEqual({ year: 2026, month: 9, day: 17, hour: 8, minute: 0 });
    expect(parseWallClock("2026-09-17T08:00:00")).toEqual({ year: 2026, month: 9, day: 17, hour: 8, minute: 0 });
    expect(parseWallClock("2026-13-01T08:00")).toBeNull();
    expect(parseWallClock("yesterday")).toBeNull();
    expect(parseWallClock("")).toBeNull();
  });

  it("validates zone names", () => {
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
