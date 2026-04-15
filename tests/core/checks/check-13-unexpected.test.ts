import { describe, expect, it } from "vitest";
import { check13Unexpected } from "../../../src/core/checks/check-13-unexpected.js";
import type { Issue, Milestone } from "../../../src/core/roadmap/parser.js";
import type { PullRequestInfo } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function issue(overrides: Partial<Issue> & { number: number }): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    state: overrides.state ?? "open",
    labels: overrides.labels ?? ["v0.1"],
    body: overrides.body ?? "",
  };
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

describe("check13Unexpected", () => {
  it("passes when no claw/ PR points to a closed issue", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 2, state: "open" })],
    };
    const result = check13Unexpected(
      [pr({ number: 100, body: "Closes #2" })],
      milestone,
    );
    expect(result.passed).toBe(true);
  });

  it("passes when the linked issue isn't in the current milestone", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 2, state: "open" })],
    };
    const result = check13Unexpected(
      [pr({ number: 100, body: "Closes #999" })],
      milestone,
    );
    expect(result.passed).toBe(true);
  });

  it("ignores non-claw/ PRs", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 2, state: "closed" })],
    };
    const result = check13Unexpected(
      [pr({ number: 100, headRef: "feature/foo", body: "Closes #2" })],
      milestone,
    );
    expect(result.passed).toBe(true);
  });

  it("ignores claw/ PRs with no linked issue (CHECK 7 owns that)", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 2, state: "closed" })],
    };
    const result = check13Unexpected(
      [pr({ number: 100, body: "no closing keyword" })],
      milestone,
    );
    expect(result.passed).toBe(true);
  });

  it("fails when a claw/ PR points to a closed issue in the milestone", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 2, state: "closed" })],
    };
    const result = check13Unexpected(
      [pr({ number: 100, body: "Closes #2" })],
      milestone,
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #100");
    expect(result.error?.message).toContain("issue #2 is closed");
    expect(result.error?.hint).toContain("merge or close");
  });
});
