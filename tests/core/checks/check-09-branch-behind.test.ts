import { describe, it, expect } from "vitest";
import { check09BranchBehind } from "../../../src/core/checks/check-09-branch-behind.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("check09BranchBehind", () => {
  it("passes when every branch is up to date", () => {
    expect(
      check09BranchBehind("main", { "claw/issue-1-foo": 0, "claw/issue-2-bar": 0 }),
    ).toEqual({ passed: true });
  });

  it("passes when there are no branches to compare", () => {
    expect(check09BranchBehind("main", {})).toEqual({ passed: true });
  });

  it("fails when at least one branch is behind", () => {
    const result = check09BranchBehind("main", {
      "claw/issue-1-foo": 0,
      "claw/issue-2-bar": 4,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("branch claw/issue-2-bar is behind main by 4 commits");
    expect(result.error?.hint).toContain("Rebase claw/issue-2-bar onto main");
  });

  it("uses singular wording for a 1-commit gap", () => {
    const result = check09BranchBehind("main", { "claw/issue-1-foo": 1 });
    expect(result.error?.message).toContain("by 1 commit.");
    expect(result.error?.message).not.toContain("1 commits");
  });

  it("reports branches in sorted order so the message is deterministic", () => {
    const result = check09BranchBehind("main", {
      "claw/zeta": 1,
      "claw/alpha": 2,
    });
    // Sorted: alpha comes first and it's behind -> it wins.
    expect(result.error?.message).toContain("claw/alpha");
  });
});
