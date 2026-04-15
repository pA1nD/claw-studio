import { describe, expect, it } from "vitest";
import type { Octokit } from "@octokit/rest";
import { check12CIFailing } from "../../../src/core/checks/check-12-ci-failing.js";
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

describe("check12CIFailing", () => {
  it("passes when CI returns no failing checks", async () => {
    const result = await check12CIFailing(stubClient, ref, [pr({ number: 1 })], {
      listFailingChecks: async () => [],
    });
    expect(result.passed).toBe(true);
  });

  it("fails with the failing check names listed", async () => {
    const result = await check12CIFailing(stubClient, ref, [pr({ number: 5 })], {
      listFailingChecks: async () => [
        { name: "Lint" },
        { name: "Tests" },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeInstanceOf(ClawError);
    expect(result.error?.message).toContain("PR #5");
    expect(result.error?.message).toContain("Lint, Tests");
    expect(result.error?.hint).toContain("Fix CI");
  });

  it("ignores non-claw/ PRs", async () => {
    const result = await check12CIFailing(
      stubClient,
      ref,
      [pr({ number: 9, headRef: "feature/foo" })],
      { listFailingChecks: async () => [{ name: "Lint" }] },
    );
    expect(result.passed).toBe(true);
  });

  it("uses the PR head SHA when looking up failing checks", async () => {
    const seenShas: string[] = [];
    await check12CIFailing(
      stubClient,
      ref,
      [pr({ number: 1, headSha: "abc123" })],
      {
        listFailingChecks: async (_ref, sha) => {
          seenShas.push(sha);
          return [];
        },
      },
    );
    expect(seenShas).toEqual(["abc123"]);
  });
});
