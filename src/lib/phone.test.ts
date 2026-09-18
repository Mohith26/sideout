import { describe, expect, it } from "vitest";
import { maskPhone, normalizePhone, phoneSchema } from "@/lib/phone";

describe("normalizePhone", () => {
  it.each([
    ["+15550100100", "+15550100100"],
    ["+1 (555) 010-0100", "+15550100100"],
    ["+44 20 7946 0958", "+442079460958"],
    ["555-010-0100", "+15550100100"],
    ["(555) 010 0100", "+15550100100"],
    ["1 555 010 0100", "+15550100100"],
    ["+1.555.010.0100", "+15550100100"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["", "   ", "+0123456789", "12345", "+1", "555 010", "+1234567890123456", "abc", "+1 555 abc 0100"])("rejects %j", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("parses through zod and masks for display", () => {
    expect(phoneSchema.parse(" +1 555 010 0100 ")).toBe("+15550100100");
    expect(phoneSchema.safeParse("nope").success).toBe(false);
    expect(maskPhone("+15550100100")).toBe("•••• 0100");
  });
});
