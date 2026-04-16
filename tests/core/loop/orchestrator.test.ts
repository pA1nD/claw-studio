import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../../../src/core/types/errors.js";
import type { Issue, Milestone } from "../../../src/core/roadmap/parser.js";
import type { PullRequestInfo } from "../../../src/core/checks/types.js";
import type { ClawConfig } from "../../../src/core/setup/config.js";
import {
  findLowestOpenIssue,
  resolveLinkedIssue,
  runCycle,
  type OrchestratorDeps,
} from "../../../src/core/loop/orchestrator.js";
import type { PRVerdict } from "../../../src/core/agents/pr-monitor.js";
import type { ReviewComment } from "../../../src/core/agents/context.js";
import type {
  ImplementationOutcome,
  FixOutcome,
} from "../../../src/core/agents/implementation.js";

const stubClient = {} as Octokit;
const REPO = "pA1nD/claw-studio";
const CWD = "/tmp/proj";

const CONFIG: ClawConfig = {
  repo: REPO,
  pollInterval: 60,
  clawVersion: "0.0.1",
};

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
    body: overrides.body ?? `Closes #${overrides.number}`,
    headRef: overrides.headRef ?? `claw/issue-${overrides.number}-x`,
    baseRef: overrides.baseRef ?? "main",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
  };
}

/**
 * Build orchestrator deps that make every step succeed. Tests override one
 * field at a time so the failure path is unambiguous.
 */
function passingDeps(
  overrides: Partial<OrchestratorDeps> & {
    issues?: Issue[];
    openPRs?: PullRequestInfo[];
    verdict?: PRVerdict;
    milestoneName?: string;
    roadmap?: string;
    branches?: { name: string; sha: string }[];
  } = {},
): OrchestratorDeps {
  const milestoneName = overrides.milestoneName ?? "v0.1";
  const issues = overrides.issues ?? [issue({ number: 7, state: "open" })];
  const branches = overrides.branches ?? [
    { name: "main", sha: "shaMain" },
    ...overrides.openPRs?.map((p) => ({
      name: p.headRef,
      sha: p.headSha,
    })) ?? [],
  ];

  return {
    roadmap: {
      readRoadmap: async () => `## Current milestone: ${milestoneName}\n`,
      listIssuesForLabel: async () => issues,
    },
    readRoadmapContent:
      overrides.readRoadmapContent ??
      (async () => overrides.roadmap ?? "## Current milestone: v0.1\n"),
    listOpenPullRequests:
      overrides.listOpenPullRequests ??
      (async () => overrides.openPRs ?? []),
    readPRVerdict:
      overrides.readPRVerdict ?? (async () => overrides.verdict ?? "pending"),
    squashMerge:
      overrides.squashMerge ?? (async () => ({ sha: "squash-sha" })),
    deleteBranch: overrides.deleteBranch ?? (async () => undefined),
    runImplementationAgent:
      overrides.runImplementationAgent ??
      (async (_client, inputs) => {
        const outcome: ImplementationOutcome = {
          branch: `claw/issue-${inputs.issue.number}-x`,
          prNumber: 100 + inputs.issue.number,
          sessionId: "session-id",
        };
        return outcome;
      }),
    runFixCycle:
      overrides.runFixCycle ??
      (async () => {
        const outcome: FixOutcome = {
          type: "fixed",
          attemptNumber: 1,
          sessionId: "session-id",
        };
        return outcome;
      }),
    fetchReviewComments:
      overrides.fetchReviewComments ?? (async () => [] as ReviewComment[]),
    deleteSession: overrides.deleteSession ?? (async () => undefined),
    inspector: overrides.inspector ?? {
      readRoadmap: async () => `## Current milestone: ${milestoneName}\n`,
      listIssuesForLabel: async () => issues,
      readDefaultBranch: async () => "main",
      listBranches: async () => branches,
      listOpenPullRequests: async () =>
        overrides.openPRs ?? [],
      compareBranchToDefault: async () => ({ behindBy: 0 }),
      listPRCommentBodies: async () => [],
      readSession: async () => null,
      listFailingChecks: async () => [],
    },
  };
}

describe("findLowestOpenIssue", () => {
  it("returns the lowest-numbered open issue", () => {
    const result = findLowestOpenIssue([
      issue({ number: 9, state: "open" }),
      issue({ number: 5, state: "open" }),
      issue({ number: 7, state: "open" }),
    ]);
    expect(result?.number).toBe(5);
  });

  it("ignores closed issues", () => {
    const result = findLowestOpenIssue([
      issue({ number: 1, state: "closed" }),
      issue({ number: 5, state: "open" }),
    ]);
    expect(result?.number).toBe(5);
  });

  it("returns null when nothing is open", () => {
    expect(findLowestOpenIssue([])).toBeNull();
    expect(
      findLowestOpenIssue([issue({ number: 1, state: "closed" })]),
    ).toBeNull();
  });
});

describe("resolveLinkedIssue", () => {
  const milestone: Milestone = {
    name: "v0.1",
    issues: [issue({ number: 7, title: "Loop orchestrator" })],
  };

  it("returns the matching issue when the body has Closes #N", () => {
    const result = resolveLinkedIssue(
      pr({ number: 99, body: "Implements the loop.\n\nCloses #7\n" }),
      milestone,
    );
    expect(result?.number).toBe(7);
  });

  it("returns null when the PR body has no closing keyword", () => {
    const result = resolveLinkedIssue(
      pr({ number: 99, body: "fix: misc tweaks" }),
      milestone,
    );
    expect(result).toBeNull();
  });

  it("returns null when the link points outside the milestone", () => {
    const result = resolveLinkedIssue(
      pr({ number: 99, body: "Closes #999" }),
      milestone,
    );
    expect(result).toBeNull();
  });
});

describe("runCycle — happy paths", () => {
  it("spawns the implementation agent on the lowest open issue when no PR is open", async () => {
    const spawn = vi.fn(async (_client, _inputs) => {
      const outcome: ImplementationOutcome = {
        branch: "claw/issue-7-loop-orchestrator",
        prNumber: 123,
        sessionId: "session-id",
      };
      return outcome;
    });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        issues: [
          issue({ number: 9, state: "open" }),
          issue({ number: 7, state: "open", title: "Loop orchestrator" }),
        ],
        runImplementationAgent: spawn,
      }),
    });

    expect(result).toEqual({
      type: "action-taken",
      action: "opened PR #123 for issue #7 on claw/issue-7-loop-orchestrator",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const callArgs = spawn.mock.calls[0]?.[1];
    expect(callArgs?.issue.number).toBe(7);
    expect(callArgs?.repo).toBe(REPO);
    expect(callArgs?.cwd).toBe(CWD);
    expect(callArgs?.milestoneName).toBe("v0.1");
    expect(callArgs?.roadmap).toContain("Current milestone: v0.1");
  });

  it("returns waiting when the open PR's verdict is pending", async () => {
    const verdictReader = vi.fn(async () => "pending" as PRVerdict);
    const openPR = pr({ number: 200, body: "Closes #7" });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        readPRVerdict: verdictReader,
      }),
    });

    expect(result).toEqual({
      type: "waiting",
      reason: "PR #200 review pending",
    });
    expect(verdictReader).toHaveBeenCalledWith(REPO, 200);
  });

  it("squash-merges, deletes the branch, and clears the session on `approved`", async () => {
    const merge = vi.fn(async () => ({ sha: "squash" }));
    const remove = vi.fn(async () => undefined);
    const deleteSession = vi.fn(async () => undefined);
    const openPR = pr({
      number: 200,
      body: "Closes #7",
      headRef: "claw/issue-7-loop-orchestrator",
    });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        verdict: "approved",
        squashMerge: merge,
        deleteBranch: remove,
        deleteSession,
      }),
    });

    expect(result.type).toBe("action-taken");
    if (result.type !== "action-taken") return;
    expect(result.action).toContain("merged PR #200");
    expect(result.action).toContain("issue #7");

    expect(merge).toHaveBeenCalledWith(REPO, 200, "Issue 7", 7);
    expect(remove).toHaveBeenCalledWith(
      REPO,
      "claw/issue-7-loop-orchestrator",
    );
    expect(deleteSession).toHaveBeenCalledWith(CWD, 7);
  });

  it("runs the fix cycle on `changes-requested`, fetching review comments", async () => {
    const reviewComments: ReviewComment[] = [
      { author: "claude[bot]", body: "## Arch Review\nCHANGES REQUESTED" },
    ];
    const fix = vi.fn(async () => {
      const outcome: FixOutcome = {
        type: "fixed",
        attemptNumber: 2,
        sessionId: "session-id",
      };
      return outcome;
    });
    const fetchComments = vi.fn(async () => reviewComments);
    const openPR = pr({ number: 200, body: "Closes #7" });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        verdict: "changes-requested",
        runFixCycle: fix,
        fetchReviewComments: fetchComments,
      }),
    });

    expect(result.type).toBe("action-taken");
    if (result.type !== "action-taken") return;
    expect(result.action).toContain("fix attempt 2");
    expect(result.action).toContain("PR #200");

    expect(fetchComments).toHaveBeenCalledWith(REPO, 200);
    const fixArgs = fix.mock.calls[0]?.[1];
    expect(fixArgs?.prNumber).toBe(200);
    expect(fixArgs?.reviewComments).toEqual(reviewComments);
    expect(fixArgs?.issue.number).toBe(7);
  });

  it("reports escalation when the fix cycle gives up", async () => {
    const fix = vi.fn(async () => {
      const outcome: FixOutcome = { type: "escalated", attemptsMade: 3 };
      return outcome;
    });
    const openPR = pr({ number: 200, body: "Closes #7" });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        verdict: "changes-requested",
        runFixCycle: fix,
      }),
    });

    expect(result.type).toBe("action-taken");
    if (result.type !== "action-taken") return;
    expect(result.action).toContain("escalated PR #200");
    expect(result.action).toContain("3 fix attempts");
    expect(result.action).toContain("needs-human");
  });
});

describe("runCycle — terminal and halt paths", () => {
  it("returns milestone-complete when CHECK 4 reports the terminal state", async () => {
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        issues: [issue({ number: 7, state: "closed" })],
        // Inspector deps must agree.
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            issue({ number: 7, state: "closed" }),
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "shaMain" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      }),
    });

    expect(result).toEqual({
      type: "milestone-complete",
      milestone: "v0.1",
    });
  });

  it("halts when the inspector reports a non-terminal failure", async () => {
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        inspector: {
          readRoadmap: async () => null, // CHECK 1 fails
        },
      }),
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toContain("no ROADMAP.md");
  });

  it("halts when the roadmap is missing (parser error before inspector)", async () => {
    // The orchestrator calls parseRoadmap which uses real Octokit by default;
    // override readRoadmapContent and inspector together so the roadmap parser
    // fails the same way as the inspector would.
    const failingDeps = passingDeps();
    // Force parseRoadmap-side failure by injecting a different config repo
    // that the parseRepoString validator rejects.
    const result = await runCycle(stubClient, { ...CONFIG, repo: "not a repo" }, {
      cwd: CWD,
      deps: failingDeps,
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toContain("invalid --repo value.");
  });

  it("halts when an approved PR has no linked issue in the milestone", async () => {
    const openPR = pr({ number: 200, body: "no closing keyword" });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        verdict: "approved",
      }),
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    // CHECK 7 catches this case before the orchestrator's `actOnOpenPR` runs,
    // so the halt comes from the inspector with its own message — both paths
    // describe the same problem ("no linked issue") so either is acceptable.
    expect(result.error.message).toMatch(/no linked issue|does not link/i);
  });

  it("halts on `ci-failing` (defensive — CHECK 12 should have caught it)", async () => {
    const openPR = pr({ number: 200, body: "Closes #7" });
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [openPR],
        verdict: "ci-failing",
      }),
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toContain("CI is failing on PR #200");
  });

  it("never throws — every uncaught error becomes a halted result", async () => {
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      // No-op sleep so the retry layer doesn't add real wall-clock time.
      sleep: async () => undefined,
      deps: passingDeps({
        listOpenPullRequests: async () => {
          throw new Error("simulated network failure");
        },
      }),
    });
    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toBe("simulated network failure");
  });

  it("converts an Octokit-shaped error to a ClawError without leaking the PAT", async () => {
    class MockOctokitError extends Error {
      public readonly status = 500;
      public readonly request = {
        headers: { authorization: "token ghp_secret" },
      };
    }
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      sleep: async () => undefined,
      deps: passingDeps({
        listOpenPullRequests: async () => {
          throw new MockOctokitError("GET /pulls - 500");
        },
      }),
    });
    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toBe("GET /pulls - 500");
    expect(JSON.stringify(result.error)).not.toContain("ghp_secret");
  });
});

describe("runCycle — retry with exponential backoff", () => {
  it("retries a transient (non-ClawError) failure up to MAX_CYCLE_ATTEMPTS", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      deps: passingDeps({
        listOpenPullRequests: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error("network glitch");
          return [];
        },
      }),
    });

    // The third attempt succeeds → the orchestrator spawns the implementation
    // agent on the lowest open issue (default issue #7).
    expect(result.type).toBe("action-taken");
    expect(attempts).toBe(3);
    // Two sleeps between three attempts: 2^1 * 1000 = 2000, then 2^2 * 1000 = 4000.
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it("halts after MAX_CYCLE_ATTEMPTS when the failure persists", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      deps: passingDeps({
        listOpenPullRequests: async () => {
          attempts += 1;
          throw new Error("network down forever");
        },
      }),
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toBe("network down forever");
    expect(attempts).toBe(3);
    // Two sleeps between three attempts.
    expect(sleeps).toHaveLength(2);
  });

  it("does NOT retry a ClawError — halts on the first attempt", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      deps: passingDeps({
        listOpenPullRequests: async () => {
          attempts += 1;
          throw new ClawError("structured failure.", "fix it.");
        },
      }),
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toBe("structured failure.");
    expect(result.error.hint).toBe("fix it.");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("runCycle — branch selection", () => {
  it("only acts on `claw/`-prefixed PRs (human PRs are ignored)", async () => {
    const humanPR = pr({
      number: 50,
      body: "Closes #7",
      headRef: "feature/some-human-branch",
    });
    const spawn = vi.fn(async () => ({
      branch: "claw/issue-7-x",
      prNumber: 600,
      sessionId: "session",
    }));
    const result = await runCycle(stubClient, CONFIG, {
      cwd: CWD,
      deps: passingDeps({
        openPRs: [humanPR],
        runImplementationAgent: spawn,
      }),
    });
    // Human PR ignored — orchestrator falls through to the spawn path.
    expect(result.type).toBe("action-taken");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
