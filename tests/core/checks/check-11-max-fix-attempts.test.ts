import { describe, expect, it } from "vitest";
import { check11MaxFixAttempts } from "../../../src/core/checks/check-11-max-fix-attempts.js";
import {
  MAX_FIX_ATTEMPTS,
  type PullRequestInfo,
  type SessionFile,
} from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

const cwd = "/tmp/claw-target";

function pr(overrides: Partial<PullRequestInfo> & { number: number }): PullRequestInfo {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "Closes #1",
    headRef: overrides.headRef ?? `claw/issue-${overrides.number}-x`,
    baseRef: overrides.baseRef ?? "main",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
  };
}

function session(issueNumber: number, fixAttempts: number): SessionFile {
  return { issueNumber, sessionId: "sid-" + issueNumber, fixAttempts };
}

describe("check11MaxFixAttempts", () => {
  it("passes when no session files exist", async () => {
    const result = await check11MaxFixAttempts(cwd, [pr({ number: 1 })], {
      readSession: async () => null,
    });
    expect(result.passed).toBe(true);
  });

  it("passes when fixAttempts is below the threshold", async () => {
    const result = await check11MaxFixAttempts(cwd, [pr({ number: 1, body: "Closes #5" })], {
      readSession: async (_cwd, n) => session(n, MAX_FIX_ATTEMPTS - 1),
    });
    expect(result.passed).toBe(true);
  });

  it("fails when fixAttempts hits the threshold", async () => {
    const result = await check11MaxFixAttempts(
      cwd,
      [pr({ number: 42, body: "Closes #5" })],
      { readSession: async (_cwd, n) => session(n, MAX_FIX_ATTEMPTS) },
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #42");
    expect(result.error?.message).toContain(`${MAX_FIX_ATTEMPTS} fix attempts`);
    expect(result.error?.hint).toContain("needs-human");
  });

  it("ignores PRs with no linked issue", async () => {
    let called = false;
    const result = await check11MaxFixAttempts(
      cwd,
      [pr({ number: 1, body: "no closing keyword" })],
      {
        readSession: async () => {
          called = true;
          return session(1, MAX_FIX_ATTEMPTS);
        },
      },
    );
    expect(result.passed).toBe(true);
    expect(called).toBe(false);
  });

  it("ignores non-claw/ PRs", async () => {
    let called = false;
    const result = await check11MaxFixAttempts(
      cwd,
      [pr({ number: 1, headRef: "feature/foo", body: "Closes #2" })],
      {
        readSession: async () => {
          called = true;
          return session(2, MAX_FIX_ATTEMPTS);
        },
      },
    );
    expect(result.passed).toBe(true);
    expect(called).toBe(false);
  });

  it("uses the issue number from the PR body, not the PR number", async () => {
    const seenIssueNumbers: number[] = [];
    await check11MaxFixAttempts(cwd, [pr({ number: 100, body: "Closes #5" })], {
      readSession: async (_cwd, n) => {
        seenIssueNumbers.push(n);
        return null;
      },
    });
    expect(seenIssueNumbers).toEqual([5]);
  });
});
