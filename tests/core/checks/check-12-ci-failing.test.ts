import { describe, it, expect } from "vitest";
import { check12CiFailing } from "../../../src/core/checks/check-12-ci-failing.js";
import type {
  PullRequestSummary,
  StatusCheckSummary,
} from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function pr(
  number: number,
  statusChecks: StatusCheckSummary[],
): PullRequestSummary {
  return {
    number,
    title: `PR #${number}`,
    body: "",
    headRef: `claw/issue-${number}-foo`,
    baseRef: "main",
    linkedIssue: number,
    reviews: [],
    statusChecks,
  };
}

describe("check12CiFailing", () => {
  it("passes when there are no open PRs", () => {
    expect(check12CiFailing([])).toEqual({ passed: true });
  });

  it("passes when every check has succeeded", () => {
    const result = check12CiFailing([
      pr(10, [
        { name: "Lint", conclusion: "success" },
        { name: "Tests", conclusion: "success" },
      ]),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("passes when checks are still running (conclusion null)", () => {
    const result = check12CiFailing([
      pr(10, [{ name: "Lint", conclusion: null }]),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("passes on 'neutral' and 'skipped' conclusions", () => {
    const result = check12CiFailing([
      pr(10, [
        { name: "Optional", conclusion: "neutral" },
        { name: "Skipped", conclusion: "skipped" },
      ]),
    ]);
    expect(result).toEqual({ passed: true });
  });

  it("fails on a 'failure' conclusion", () => {
    const result = check12CiFailing([
      pr(10, [
        { name: "Tests", conclusion: "failure" },
        { name: "Lint", conclusion: "success" },
      ]),
    ]);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("CI is failing on PR #10: Tests");
    expect(result.error?.hint).toContain("failing jobs on PR #10");
  });

  it("reports every failing check name", () => {
    const result = check12CiFailing([
      pr(11, [
        { name: "Tests", conclusion: "failure" },
        { name: "Lint", conclusion: "timed_out" },
      ]),
    ]);
    expect(result.error?.message).toContain("Tests");
    expect(result.error?.message).toContain("Lint");
  });

  it("treats cancelled and timed_out as failures", () => {
    expect(
      check12CiFailing([pr(1, [{ name: "Lint", conclusion: "cancelled" }])]).passed,
    ).toBe(false);
    expect(
      check12CiFailing([pr(1, [{ name: "Lint", conclusion: "timed_out" }])]).passed,
    ).toBe(false);
  });
});
