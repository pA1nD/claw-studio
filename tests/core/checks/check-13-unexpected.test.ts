import { describe, it, expect } from "vitest";
import { check13Unexpected } from "../../../src/core/checks/check-13-unexpected.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";
import type {
  PullRequestSummary,
  SessionRecord,
} from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

function issue(number: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    state: "open",
    labels: ["v0.1"],
    body: "",
  };
}

function pr(number: number, linkedIssue: number | null): PullRequestSummary {
  return {
    number,
    title: `PR #${number}`,
    body: "",
    headRef: `claw/issue-${number}-foo`,
    baseRef: "main",
    linkedIssue,
    reviews: [],
    statusChecks: [],
  };
}

function session(issueNumber: number): SessionRecord {
  return { issueNumber, sessionId: "abc", fixAttempts: 0 };
}

describe("check13Unexpected", () => {
  it("passes when nothing unusual is present", () => {
    const result = check13Unexpected([issue(1), issue(2)], [pr(10, 1)], {
      1: session(1),
    });
    expect(result).toEqual({ passed: true });
  });

  it("fails when a session file references an issue that is not in the milestone", () => {
    const result = check13Unexpected([issue(1)], [], { 99: session(99) });
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("session file references issue #99");
    expect(result.error?.hint).toContain("sessions/99.json");
  });

  it("fails when a PR links to an issue that is not in the milestone", () => {
    const result = check13Unexpected([issue(1)], [pr(10, 99)], {});
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain(
      "PR #10 links to issue #99, which is not in the current milestone",
    );
  });

  it("prioritises orphan sessions over orphan PRs when both exist", () => {
    const result = check13Unexpected([issue(1)], [pr(10, 99)], { 50: session(50) });
    expect(result.error?.message).toContain("#50");
  });

  it("reports the lowest-numbered orphan session first for stability", () => {
    const result = check13Unexpected([], [], {
      50: session(50),
      30: session(30),
      70: session(70),
    });
    expect(result.error?.message).toContain("#30");
  });
});
