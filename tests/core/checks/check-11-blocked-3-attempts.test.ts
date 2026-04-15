import { describe, it, expect } from "vitest";
import {
  check11Blocked3Attempts,
  MAX_FIX_ATTEMPTS,
} from "../../../src/core/checks/check-11-blocked-3-attempts.js";
import type {
  PullRequestSummary,
  SessionRecord,
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

function session(
  issueNumber: number,
  fixAttempts: number,
): Record<number, SessionRecord> {
  return {
    [issueNumber]: { issueNumber, sessionId: "abc", fixAttempts },
  };
}

describe("check11Blocked3Attempts", () => {
  it("passes when there are no open PRs", () => {
    expect(check11Blocked3Attempts([], {})).toEqual({ passed: true });
  });

  it("passes when no session has hit the limit", () => {
    expect(
      check11Blocked3Attempts(
        [pr({ number: 10, linkedIssue: 1 })],
        session(1, 1),
      ),
    ).toEqual({ passed: true });
  });

  it("passes when the limit is reached but no reviewer has 'CHANGES REQUESTED'", () => {
    expect(
      check11Blocked3Attempts(
        [
          pr({
            number: 10,
            linkedIssue: 1,
            reviews: [{ agent: "Arch", verdict: "APPROVED" }],
          }),
        ],
        session(1, MAX_FIX_ATTEMPTS),
      ),
    ).toEqual({ passed: true });
  });

  it("fails when attempts are at the limit and a reviewer still has CHANGES REQUESTED", () => {
    const result = check11Blocked3Attempts(
      [
        pr({
          number: 10,
          linkedIssue: 1,
          reviews: [
            { agent: "Arch", verdict: "APPROVED" },
            { agent: "Security", verdict: "CHANGES REQUESTED" },
          ],
        }),
      ],
      session(1, MAX_FIX_ATTEMPTS),
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #10 has been through 3 fix attempts");
    expect(result.error?.hint).toContain("needs-human label");
    expect(result.error?.hint).toContain("sessions/1.json");
  });

  it("ignores PRs that are not linked to an issue — CHECK 7 owns that case", () => {
    const result = check11Blocked3Attempts(
      [
        pr({
          number: 10,
          linkedIssue: null,
          reviews: [{ agent: "Arch", verdict: "CHANGES REQUESTED" }],
        }),
      ],
      {},
    );
    expect(result).toEqual({ passed: true });
  });

  it("ignores PRs with no matching session (no attempts recorded yet)", () => {
    const result = check11Blocked3Attempts(
      [
        pr({
          number: 10,
          linkedIssue: 99,
          reviews: [{ agent: "Arch", verdict: "CHANGES REQUESTED" }],
        }),
      ],
      {},
    );
    expect(result).toEqual({ passed: true });
  });
});
