import { describe, it, expect } from "vitest";
import { check01Roadmap } from "../../../src/core/checks/check-01-roadmap.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("check01Roadmap", () => {
  it("passes when a ROADMAP was loaded", () => {
    expect(check01Roadmap(true, "owner/repo")).toEqual({ passed: true });
  });

  it("fails with a ClawError when no ROADMAP was loaded", () => {
    const result = check01Roadmap(false, "pA1nD/claw-studio");
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("no ROADMAP.md found in pA1nD/claw-studio");
    expect(result.error?.hint).toContain("Add a ROADMAP.md");
  });

  it("does not set `terminal` on failure — CHECK 1 is an error state", () => {
    const result = check01Roadmap(false, "owner/repo");
    expect(result.terminal).toBeUndefined();
  });
});
