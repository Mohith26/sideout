import { describe, expect, it } from "vitest";
import { safeNextPath, signInHref } from "@/lib/redirects";

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/me")).toBe("/me");
    expect(safeNextPath("/t/sandbar-classic-2026/register?team=1")).toBe("/t/sandbar-classic-2026/register?team=1");
    expect(safeNextPath(["/events", "/other"])).toBe("/events");
  });

  it("refuses anything that could leave the origin", () => {
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("/me\nSet-Cookie: x")).toBe("/");
    expect(safeNextPath(undefined, "/events")).toBe("/events");
    expect(safeNextPath("")).toBe("/");
  });

  it("never loops back into sign-in", () => {
    expect(safeNextPath("/sign-in?next=/me")).toBe("/");
    expect(signInHref("/me")).toBe("/sign-in?next=%2Fme");
  });
});
