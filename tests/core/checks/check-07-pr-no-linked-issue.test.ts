import { describe, it, expect } from "vitest";
import { check07PrNoLinkedIssue } from "../../../src/core/checks/check-07-pr-no-linked-issue.js";
import type { PullRequestSummary } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function pr(overrides: Partial<PullRequestSummary> & { number: number }): PullRequestSummary {
  return {
    number: overrides.number,
    title: overrides.title ?? "Test PR",
    body: overrides.body ?? "",
    headRef: overrides.headRef ?? `claw/issue-${overrides.number}-foo`,
    baseRef: overrides.baseRef ?? "main",
    linkedIssue: overrides.linkedIssue ?? null,
    reviews: overrides.reviews ?? [],
    statusChecks: overrides.statusChecks ?? [],
  };
}

describe("check07PrNoLinkedIssue", () => {
  it("passes when there are no open PRs", () => {
    expect(check07PrNoLinkedIssue([])).toEqual({ passed: true });
  });

  it("passes when every open PR links to an issue", () => {
    const result = check07PrNoLinkedIssue([
      pr({ number: 10, linkedIssue: 5 }),
      pr({ number: 11, linkedIssue: 7 }),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("fails when a PR has no linked issue", () => {
    const result = check07PrNoLinkedIssue([
      pr({ number: 10, linkedIssue: 5 }),
      pr({ number: 11, linkedIssue: null }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #11 has no linked issue");
    expect(result.error?.hint).toContain("Closes #N");
  });

  it("reports the first offending PR in iteration order", () => {
    const result = check07PrNoLinkedIssue([
      pr({ number: 3, linkedIssue: null }),
      pr({ number: 4, linkedIssue: null }),
    ]);
    expect(result.error?.message).toContain("PR #3");
  });
});
