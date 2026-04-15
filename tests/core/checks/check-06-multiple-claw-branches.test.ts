import { describe, it, expect } from "vitest";
import { check06MultipleClawBranches } from "../../../src/core/checks/check-06-multiple-claw-branches.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("check06MultipleClawBranches", () => {
  it("passes when no branches exist", () => {
    expect(check06MultipleClawBranches([])).toEqual({ passed: true });
  });

  it("passes when exactly one claw/ branch exists", () => {
    expect(check06MultipleClawBranches(["claw/issue-1-foo"])).toEqual({
      passed: true,
    });
  });

  it("fails when two or more claw/ branches exist", () => {
    const result = check06MultipleClawBranches([
      "claw/issue-2-bar",
      "claw/issue-1-foo",
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("2 open claw/ branches");
    // Sorted order is deterministic.
    expect(result.error?.message).toContain("claw/issue-1-foo, claw/issue-2-bar");
    expect(result.error?.hint).toContain("one issue at a time");
  });

  it("sorts the listed branches lexicographically for a stable message", () => {
    const result = check06MultipleClawBranches([
      "claw/issue-10-z",
      "claw/issue-2-a",
      "claw/issue-7-m",
    ]);
    expect(result.error?.message).toContain(
      "claw/issue-10-z, claw/issue-2-a, claw/issue-7-m",
    );
  });
});
