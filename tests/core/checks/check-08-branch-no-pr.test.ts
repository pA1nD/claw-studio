import { describe, expect, it } from "vitest";
import { check08BranchNoPR } from "../../../src/core/checks/check-08-branch-no-pr.js";
import type { BranchInfo, PullRequestInfo } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function branch(name: string): BranchInfo {
  return { name, sha: "abc" };
}

function pr(overrides: Partial<PullRequestInfo> & { number: number }): PullRequestInfo {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    headRef: overrides.headRef ?? `claw/issue-${overrides.number}-x`,
    baseRef: overrides.baseRef ?? "main",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
  };
}

describe("check08BranchNoPR", () => {
  it("passes when every claw/ branch has an open PR", () => {
    const result = check08BranchNoPR(
      [branch("main"), branch("claw/issue-2-x")],
      [pr({ number: 100, headRef: "claw/issue-2-x" })],
    );
    expect(result.passed).toBe(true);
  });

  it("ignores non-claw branches without PRs (humans own those)", () => {
    expect(
      check08BranchNoPR([branch("feature/x"), branch("main")], []).passed,
    ).toBe(true);
  });

  it("fails on the first orphaned claw/ branch", () => {
    const result = check08BranchNoPR(
      [branch("claw/issue-2-x"), branch("claw/issue-7-y")],
      [pr({ number: 50, headRef: "claw/issue-7-y" })],
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("claw/issue-2-x");
    expect(result.error?.hint).toContain("delete the branch");
  });
});
