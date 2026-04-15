import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { check10MissingReviews } from "../../../src/core/checks/check-10-missing-reviews.js";
import { REVIEW_AGENT_HEADERS } from "../../../src/core/checks/types.js";
import type { PullRequestInfo } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const ref = { owner: "pA1nD", repo: "claw-studio" };

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

describe("check10MissingReviews", () => {
  it("passes when every claw/ PR has all five reviews posted", async () => {
    const allFive = REVIEW_AGENT_HEADERS.map((header) => `${header}\n\nAPPROVED — ok.`);
    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 1 })],
      { listPRCommentBodies: async () => allFive },
    );
    expect(result.passed).toBe(true);
  });

  it("passes when zero reviews are present (still pending)", async () => {
    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 1 })],
      { listPRCommentBodies: async () => [] },
    );
    expect(result.passed).toBe(true);
  });

  it("ignores non-claw/ PRs", async () => {
    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 1, headRef: "feature/foo" })],
      {
        listPRCommentBodies: async () => ["## Arch Review\n\nAPPROVED"],
      },
    );
    expect(result.passed).toBe(true);
  });

  it("fails with a partial review set and lists what is missing", async () => {
    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 9 })],
      {
        listPRCommentBodies: async () => [
          "## Arch Review\n\nAPPROVED",
          "## DX Review\n\nAPPROVED",
        ],
      },
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #9");
    expect(result.error?.message).toContain("Security Review");
    expect(result.error?.message).toContain("Perf Review");
    expect(result.error?.message).toContain("Test Review");
    // Already-posted agents should NOT be in the missing list.
    expect(result.error?.message).not.toContain("Arch Review");
    expect(result.error?.message).not.toContain("DX Review");
    expect(result.error?.hint).toContain("Push an empty commit");
  });

  it("matches headers regardless of leading whitespace in the comment body", async () => {
    const allFive = REVIEW_AGENT_HEADERS.map(
      (header) => `   \n${header}\n\nAPPROVED`,
    );
    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 1 })],
      { listPRCommentBodies: async () => allFive },
    );
    expect(result.passed).toBe(true);
  });

  it("continues past a fully-reviewed PR and fails on a later partial one", async () => {
    // Guards against a regression where a misplaced `return { passed: true }`
    // inside the loop short-circuits after the first complete PR.
    const allFive = REVIEW_AGENT_HEADERS.map((h) => `${h}\n\nAPPROVED`);
    const partial = [`${REVIEW_AGENT_HEADERS[0]}\n\nAPPROVED`];
    const listBodies = vi
      .fn()
      .mockResolvedValueOnce(allFive)
      .mockResolvedValueOnce(partial);

    const result = await check10MissingReviews(
      stubClient,
      ref,
      [pr({ number: 1 }), pr({ number: 2 })],
      { listPRCommentBodies: listBodies },
    );
    expect(listBodies).toHaveBeenCalledTimes(2);
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("PR #2");
    expect(result.error?.message).toContain("missing reviews from");
  });
});
