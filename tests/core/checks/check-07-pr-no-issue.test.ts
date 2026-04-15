import { describe, expect, it } from "vitest";
import { check07PRNoIssue } from "../../../src/core/checks/check-07-pr-no-issue.js";
import {
  hasLinkedIssue,
  type PullRequestInfo,
} from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

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

describe("hasLinkedIssue", () => {
  it.each([
    "Closes #2",
    "closes #2",
    "Fixes #42",
    "Resolves #100",
    "Some text\n\nCloses #5\n",
    "FIXES #1",
  ])("recognises '%s' as a linked issue", (body) => {
    expect(hasLinkedIssue(body)).toBe(true);
  });

  it.each([
    "",
    "No reference here",
    "See #2",
    "Issue 2",
    "closes#2", // missing whitespace
  ])("does NOT recognise '%s' as a linked issue", (body) => {
    expect(hasLinkedIssue(body)).toBe(false);
  });
});

describe("check07PRNoIssue", () => {
  it("passes when every claw/ PR has a Closes #N line", () => {
    const result = check07PRNoIssue([
      pr({ number: 1, body: "Closes #2" }),
      pr({ number: 2, body: "Fixes #3" }),
    ]);
    expect(result.passed).toBe(true);
  });

  it("passes when no claw/ PRs are open", () => {
    expect(check07PRNoIssue([]).passed).toBe(true);
  });

  it("ignores non-claw/ PRs", () => {
    expect(
      check07PRNoIssue([
        pr({ number: 9, headRef: "feature/foo", body: "" }),
      ]).passed,
    ).toBe(true);
  });

  it("fails on the first claw/ PR with no closing keyword", () => {
    const result = check07PRNoIssue([
      pr({ number: 1, body: "Closes #2" }),
      pr({ number: 2, body: "no marker here" }),
      pr({ number: 3, body: "no marker either" }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    // Reports the first offending PR.
    expect(result.error?.message).toContain("PR #2");
    expect(result.error?.hint).toContain("Closes #N");
  });
});
