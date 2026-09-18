import { describe, expect, it } from "vitest";
import { centsToAmountString, countdownParts, formatCents, formatPercent, formatRelative, formatSigned, initials, ordinal, pairName, parseAmountToCents, surname } from "@/lib/format";

describe("format", () => {
  it("formats cents as whole dollars unless there are cents", () => {
    expect(formatCents(750000, "USD")).toBe("$7,500");
    expect(formatCents(1250, "USD")).toBe("$12.50");
    expect(formatCents(0, "USD")).toBe("$0");
  });

  it("rounds percentages and never goes negative", () => {
    expect(formatPercent(0.5913)).toBe("59%");
    expect(formatPercent(1.047)).toBe("105%");
    expect(formatPercent(-0.2)).toBe("0%");
  });

  it("builds team names from surnames, keeping particles", () => {
    expect(surname("Bram de Vries")).toBe("de Vries");
    expect(surname("Madonna")).toBe("Madonna");
    expect(pairName("Maya Delgado", "Bram de Vries")).toBe("Delgado / de Vries");
    expect(initials("Maya Delgado")).toBe("MD");
    expect(initials("Cher")).toBe("C");
  });

  it("gives coarse relative dates and whole countdown parts", () => {
    const now = Date.UTC(2026, 8, 17, 12);
    expect(formatRelative(now + 5 * 7 * 86_400_000, now)).toBe("in 5 weeks");
    expect(formatRelative(now - 45 * 86_400_000, now)).toBe("6 weeks ago");
    expect(formatRelative(now - 90 * 86_400_000, now)).toBe("3 months ago");
    expect(countdownParts(now + (2 * 1440 + 3 * 60 + 7) * 60_000, now)).toEqual({ days: 2, hours: 3, minutes: 7 });
    expect(countdownParts(now - 1, now)).toBeNull();
  });

  it("parses money inputs into cents and back without floats", () => {
    expect(parseAmountToCents("75")).toBe(7500);
    expect(parseAmountToCents("$75.00")).toBe(7500);
    expect(parseAmountToCents("1,250.5")).toBe(125050);
    expect(parseAmountToCents("0")).toBe(0);
    expect(parseAmountToCents("12.345")).toBeNull();
    expect(parseAmountToCents("-5")).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(centsToAmountString(7500)).toBe("75");
    expect(centsToAmountString(1250)).toBe("12.50");
  });

  it("formats ordinals and signed differentials", () => {
    expect([1, 2, 3, 4, 11, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "22nd"]);
    expect(formatSigned(12)).toBe("+12");
    expect(formatSigned(-4)).toBe("\u22124");
    expect(formatSigned(0)).toBe("0");
  });
});
