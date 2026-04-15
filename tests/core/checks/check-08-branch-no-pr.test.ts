import { describe, it, expect } from "vitest";
import { check08BranchNoPr } from "../../../src/core/checks/check-08-branch-no-pr.js";
import type { PullRequestSummary } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function pr(headRef: string, number: number): PullRequestSummary {
  return {
    number,
    title: `PR #${number}`,
    body: "",
    headRef,
    baseRef: "main",
    linkedIssue: null,
    reviews: [],
    statusChecks: [],
  };
}

describe("check08BranchNoPr", () => {
  it("passes when branches and PRs match up", () => {
    const result = check08BranchNoPr(["claw/issue-1-foo"], [pr("claw/issue-1-foo", 10)]);
    expect(result).toEqual({ passed: true });
  });

  it("passes when there are no claw/ branches", () => {
    expect(check08BranchNoPr([], [])).toEqual({ passed: true });
  });

  it("fails when a claw/ branch has no matching open PR", () => {
    const result = check08BranchNoPr(
      ["claw/issue-1-foo", "claw/issue-2-bar"],
      [pr("claw/issue-1-foo", 10)],
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("branch claw/issue-2-bar");
    expect(result.error?.hint).toContain("Open a PR from claw/issue-2-bar");
  });

  it("reports the first orphan branch in list order", () => {
    const result = check08BranchNoPr(
      ["claw/a", "claw/b", "claw/c"],
      [pr("claw/b", 99)],
    );
    expect(result.error?.message).toContain("claw/a");
  });
});
