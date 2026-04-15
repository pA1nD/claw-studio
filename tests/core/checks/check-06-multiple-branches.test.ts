import { describe, expect, it } from "vitest";
import { check06MultipleBranches } from "../../../src/core/checks/check-06-multiple-branches.js";
import type { BranchInfo } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function branch(name: string): BranchInfo {
  return { name, sha: "deadbeef" };
}

describe("check06MultipleBranches", () => {
  it("passes with zero claw/ branches", () => {
    expect(
      check06MultipleBranches([branch("main"), branch("feature/x")]).passed,
    ).toBe(true);
  });

  it("passes with exactly one claw/ branch", () => {
    expect(
      check06MultipleBranches([
        branch("main"),
        branch("claw/issue-2-state-inspector"),
      ]).passed,
    ).toBe(true);
  });

  it("ignores non-claw branches when counting", () => {
    expect(
      check06MultipleBranches([
        branch("feature/a"),
        branch("feature/b"),
        branch("claw/issue-2-x"),
      ]).passed,
    ).toBe(true);
  });

  it("fails with two or more claw/ branches and lists them sorted", () => {
    const result = check06MultipleBranches([
      branch("claw/issue-7-loop"),
      branch("main"),
      branch("claw/issue-2-state-inspector"),
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    // Sorted alphabetically — issue-2 before issue-7.
    expect(result.error?.message).toContain(
      "claw/issue-2-state-inspector, claw/issue-7-loop",
    );
    expect(result.error?.hint).toContain("at most one in-flight");
  });
});
