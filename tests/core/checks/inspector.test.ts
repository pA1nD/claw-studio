import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { inspectRepo } from "../../../src/core/checks/inspector.js";
import type { InspectorDeps } from "../../../src/core/checks/inspector.js";
import {
  MAX_FIX_ATTEMPTS,
  NEEDS_HUMAN_LABEL,
  REVIEW_AGENT_HEADERS,
} from "../../../src/core/checks/types.js";
import type {
  PullRequestInfo,
  SessionFile,
} from "../../../src/core/checks/types.js";
import type { Issue } from "../../../src/core/roadmap/parser.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const REPO = "pA1nD/claw-studio";

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

/**
 * Build a baseline set of deps that makes every check pass. Individual tests
 * override a single field to drive a single check to failure — that way the
 * test's intent is obvious without restating 12 unrelated mocks.
 */
function passingDeps(overrides: Partial<InspectorDeps> = {}): InspectorDeps {
  return {
    readRoadmap: async () => "## Current milestone: v0.1",
    listIssuesForLabel: async () => [issue({ number: 2, state: "open" })],
    readDefaultBranch: async () => "main",
    listBranches: async () => [{ name: "main", sha: "shaMain" }],
    listOpenPullRequests: async () => [],
    compareBranchToDefault: async () => ({ behindBy: 0 }),
    listPRCommentBodies: async () => [],
    readSession: async () => null,
    listFailingChecks: async () => [],
    ...overrides,
  };
}

describe("inspectRepo", () => {
  it("returns { passed: true } when every check passes", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      cwd: "/tmp/x",
      deps: passingDeps(),
    });
    expect(result).toEqual({ passed: true });
  });

  // -- Each check, exercised in isolation -------------------------------

  it("CHECK 1 — fails and halts when ROADMAP.md is missing", async () => {
    const listIssues = vi.fn(async () => []);
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        readRoadmap: async () => null,
        listIssuesForLabel: listIssues,
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("no ROADMAP.md");
    // Halts immediately — later steps never ran.
    expect(listIssues).not.toHaveBeenCalled();
  });

  it("CHECK 2 — fails when no current milestone is marked", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({ readRoadmap: async () => "# nothing" }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("no current milestone");
  });

  it("CHECK 3 — fails when no issues exist for the milestone", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({ listIssuesForLabel: async () => [] }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("no issues labeled v0.1");
  });

  it("CHECK 4 — terminal flag set when every issue is closed", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listIssuesForLabel: async () => [issue({ number: 1, state: "closed" })],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.terminal).toBe(true);
    expect(result.error?.message).toContain("all v0.1 issues are closed");
  });

  it("CHECK 5 — fails when the lowest open issue is needs-human", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listIssuesForLabel: async () => [
          issue({ number: 2, labels: ["v0.1", NEEDS_HUMAN_LABEL] }),
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("needs-human");
  });

  it("CHECK 6 — fails with multiple claw/ branches", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
          { name: "claw/issue-7-y", sha: "sha7" },
        ],
        // Both have open PRs so we don't fall through to CHECK 8 instead.
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "Closes #2" }),
          pr({ number: 101, headRef: "claw/issue-7-y", body: "Closes #7" }),
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("multiple open claw/ branches");
  });

  it("CHECK 7 — fails when an open claw/ PR has no linked issue", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "no marker" }),
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("PR #100 has no linked issue");
  });

  it("CHECK 8 — fails when a claw/ branch has no PR", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-orphan", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("claw/issue-2-orphan");
    expect(result.error?.message).toContain("no open PR");
  });

  it("CHECK 9 — fails when a claw/ branch is behind default", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "Closes #2" }),
        ],
        compareBranchToDefault: async () => ({ behindBy: 3 }),
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("behind main by 3 commits");
  });

  it("CHECK 10 — fails when a PR has partial review comments", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "Closes #2" }),
        ],
        listPRCommentBodies: async () => [
          REVIEW_AGENT_HEADERS[0] + "\n\nAPPROVED",
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("missing reviews from");
  });

  it("CHECK 11 — fails when fixAttempts has hit the threshold", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "Closes #2" }),
        ],
        listPRCommentBodies: async () =>
          REVIEW_AGENT_HEADERS.map((h) => h + "\n\nAPPROVED"),
        readSession: async (_cwd, n): Promise<SessionFile | null> => ({
          issueNumber: n,
          sessionId: "sid",
          fixAttempts: MAX_FIX_ATTEMPTS,
        }),
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain(`${MAX_FIX_ATTEMPTS} fix attempts`);
  });

  it("CHECK 12 — fails when CI is failing on an open claw/ PR", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-x", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-x", body: "Closes #2" }),
        ],
        listPRCommentBodies: async () =>
          REVIEW_AGENT_HEADERS.map((h) => h + "\n\nAPPROVED"),
        listFailingChecks: async () => [{ name: "Tests" }],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("CI is failing");
  });

  it("CHECK 13 — fails when a claw/ PR links to a closed milestone issue", async () => {
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listIssuesForLabel: async () => [
          issue({ number: 2, state: "closed" }),
          issue({ number: 7, state: "open" }),
        ],
        listBranches: async () => [
          { name: "main", sha: "shaMain" },
          { name: "claw/issue-2-stale", sha: "sha2" },
        ],
        listOpenPullRequests: async () => [
          pr({ number: 100, headRef: "claw/issue-2-stale", body: "Closes #2" }),
        ],
        listPRCommentBodies: async () =>
          REVIEW_AGENT_HEADERS.map((h) => h + "\n\nAPPROVED"),
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toContain("unexpected state");
    expect(result.error?.message).toContain("issue #2 is closed");
  });

  // -- Ordering / halt-on-first-failure ---------------------------------

  it("halts on the FIRST failing check — does not run later checks", async () => {
    // CHECK 3 (no issues) fails. CHECKs 4+ should never run, so listBranches
    // is never called.
    const listBranches = vi.fn(async () => []);
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listIssuesForLabel: async () => [],
        listBranches,
      }),
    });
    expect(result.passed).toBe(false);
    expect(listBranches).not.toHaveBeenCalled();
  });

  it("rejects a malformed repo string with a ClawError", async () => {
    await expect(
      inspectRepo(stubClient, "not-a-repo", { deps: passingDeps() }),
    ).rejects.toBeInstanceOf(ClawError);
  });

  it("passes the resolved owner/repo through to deps", async () => {
    const seen: { label?: string; ref?: { owner: string; repo: string } } = {};
    await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listIssuesForLabel: async (ref, label) => {
          seen.ref = ref;
          seen.label = label;
          return [issue({ number: 2 })];
        },
      }),
    });
    expect(seen.ref).toEqual({ owner: "pA1nD", repo: "claw-studio" });
    expect(seen.label).toBe("v0.1");
  });

  // -- Rate-limit handling ---------------------------------------------

  it("converts a 429 rate-limit error into a formatted ClawError", async () => {
    const rateLimitError = Object.assign(new Error("rate limited"), {
      status: 429,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1776600000", // fixed epoch → stable assertion
        },
      },
    });
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        readRoadmap: async () => {
          throw rateLimitError;
        },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toBe("GitHub API rate limit reached.");
    expect(result.error?.hint).toContain("Limit resets at");
    expect(result.error?.hint).toContain(
      new Date(1776600000 * 1000).toISOString(),
    );
  });

  it("converts a 403 with X-RateLimit-Remaining: 0 into a rate-limit ClawError", async () => {
    const rateLimitError = Object.assign(new Error("forbidden"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0" } },
    });
    const result = await inspectRepo(stubClient, REPO, {
      deps: passingDeps({
        listBranches: async () => {
          throw rateLimitError;
        },
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.error?.message).toBe("GitHub API rate limit reached.");
  });

  it("does NOT intercept a 403 that is not a rate-limit error", async () => {
    const forbidden = Object.assign(new Error("forbidden"), {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "42" } },
    });
    await expect(
      inspectRepo(stubClient, REPO, {
        deps: passingDeps({
          readRoadmap: async () => {
            throw forbidden;
          },
        }),
      }),
    ).rejects.toBe(forbidden);
  });

  it("re-throws errors that are not rate-limit responses", async () => {
    const genericError = new Error("network down");
    await expect(
      inspectRepo(stubClient, REPO, {
        deps: passingDeps({
          readRoadmap: async () => {
            throw genericError;
          },
        }),
      }),
    ).rejects.toBe(genericError);
  });
});
