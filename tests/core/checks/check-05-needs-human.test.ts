import { describe, expect, it } from "vitest";
import { check05NeedsHuman } from "../../../src/core/checks/check-05-needs-human.js";
import type { Issue, Milestone } from "../../../src/core/roadmap/parser.js";
import {
  NEEDS_HUMAN_LABEL,
  type PullRequestInfo,
} from "../../../src/core/checks/types.js";
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

describe("check05NeedsHuman", () => {
  it("passes when the lowest open issue has no needs-human label", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 1, labels: ["v0.1"] })],
    };
    expect(check05NeedsHuman(milestone, []).passed).toBe(true);
  });

  it("passes when there are no open issues at all (CHECK 4 owns that case)", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 1, state: "closed", labels: ["v0.1", NEEDS_HUMAN_LABEL] })],
    };
    expect(check05NeedsHuman(milestone, []).passed).toBe(true);
  });

  it("fails when the lowest-numbered open issue has needs-human", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [
        issue({ number: 7, labels: ["v0.1"] }),
        issue({ number: 2, labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
      ],
    };
    const result = check05NeedsHuman(milestone, []);
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("issue #2 is labeled needs-human");
  });

  it("does NOT fail when only a higher-numbered open issue has the label", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [
        issue({ number: 2, labels: ["v0.1"] }),
        issue({ number: 5, labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
      ],
    };
    expect(check05NeedsHuman(milestone, []).passed).toBe(true);
  });

  it("ignores closed issues when picking the current target", () => {
    // The lowest open issue is #4 (not closed #1). #4 has needs-human → fail.
    const milestone: Milestone = {
      name: "v0.1",
      issues: [
        issue({ number: 1, state: "closed", labels: ["v0.1"] }),
        issue({ number: 4, labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
      ],
    };
    const result = check05NeedsHuman(milestone, []);
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("issue #4");
  });

  it("includes the linked PR number in the hint when one is found", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 9, labels: ["v0.1", NEEDS_HUMAN_LABEL] })],
    };
    const result = check05NeedsHuman(milestone, [
      pr({ number: 42, body: "Implements stuff.\n\nCloses #9" }),
    ]);
    expect(result.error?.hint).toContain("PR #42");
  });

  it("falls back to the issue number when no linked PR can be found", () => {
    const milestone: Milestone = {
      name: "v0.1",
      issues: [issue({ number: 9, labels: ["v0.1", NEEDS_HUMAN_LABEL] })],
    };
    const result = check05NeedsHuman(milestone, []);
    expect(result.error?.hint).toContain("issue #9");
  });
});
