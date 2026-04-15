import { describe, it, expect } from "vitest";
import { check10MissingReviews } from "../../../src/core/checks/check-10-missing-reviews.js";
import { REVIEW_AGENTS } from "../../../src/core/checks/pr.js";
import type {
  PullRequestSummary,
  ReviewVerdict,
} from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function pr(overrides: Partial<PullRequestSummary> & { number: number }): PullRequestSummary {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR #${overrides.number}`,
    body: overrides.body ?? "",
    headRef: overrides.headRef ?? "claw/issue-1-foo",
    baseRef: overrides.baseRef ?? "main",
    linkedIssue: overrides.linkedIssue ?? 1,
    reviews: overrides.reviews ?? [],
    statusChecks: overrides.statusChecks ?? [],
  };
}

function approvals(): ReviewVerdict[] {
  return REVIEW_AGENTS.map((agent) => ({ agent, verdict: "APPROVED" as const }));
}

describe("check10MissingReviews", () => {
  it("passes when there are no open PRs", () => {
    expect(check10MissingReviews([])).toEqual({ passed: true });
  });

  it("passes when all expected agents have posted (APPROVED or CHANGES REQUESTED)", () => {
    const result = check10MissingReviews([pr({ number: 10, reviews: approvals() })]);
    expect(result).toEqual({ passed: true });
  });

  it("passes when verdicts are mixed as long as each agent posted something", () => {
    const mixed: ReviewVerdict[] = REVIEW_AGENTS.map((agent, i) => ({
      agent,
      verdict: i === 0 ? "CHANGES REQUESTED" : "APPROVED",
    }));
    expect(check10MissingReviews([pr({ number: 10, reviews: mixed })])).toEqual({
      passed: true,
    });
  });

  it("fails when any agent is missing", () => {
    const partial = approvals().filter((r) => r.agent !== "Security");
    const result = check10MissingReviews([pr({ number: 10, reviews: partial })]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #10 is missing reviews from: Security");
    expect(result.error?.hint).toContain("self-hosted runners");
  });

  it("reports every missing agent in one message", () => {
    const result = check10MissingReviews([
      pr({
        number: 11,
        reviews: approvals().filter((r) => r.agent === "Arch" || r.agent === "DX"),
      }),
    ]);
    expect(result.error?.message).toMatch(/Security/);
    expect(result.error?.message).toMatch(/Perf/);
    expect(result.error?.message).toMatch(/Test/);
  });

  it("fires on the first PR with missing agents", () => {
    const result = check10MissingReviews([
      pr({ number: 1, reviews: approvals() }),
      pr({ number: 2, reviews: [] }),
      pr({ number: 3, reviews: [] }),
    ]);
    expect(result.error?.message).toContain("PR #2");
  });
});
