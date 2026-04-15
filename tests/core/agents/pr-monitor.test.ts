import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  allReviewsPosted,
  getPRVerdict,
  hasFailingRun,
  latestReviewSummary,
  READY_TO_MERGE_MARKER,
  BLOCKING_ISSUES_MARKER,
  REVIEW_SUMMARY_HEADER,
} from "../../../src/core/agents/pr-monitor.js";
import type {
  CIRun,
  PRMetadata,
  PRMonitorDeps,
} from "../../../src/core/agents/pr-monitor.js";
import { REVIEW_AGENT_HEADERS } from "../../../src/core/checks/types.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const REPO = "pA1nD/claw-studio";
const PR = 42;
const HEAD_SHA = "abc123";

/** Build a stub PRMetadata — defaults to a clean, ready-to-merge shape. */
function meta(overrides: Partial<PRMetadata> = {}): PRMetadata {
  return {
    headSha: overrides.headSha ?? HEAD_SHA,
    mergeableState: overrides.mergeableState ?? "clean",
  };
}

/** Build a success-conclusion CI run by name. */
function successRun(name: string): CIRun {
  return { name, conclusion: "success" };
}

/** Build a failure-conclusion CI run by name. */
function failureRun(name: string): CIRun {
  return { name, conclusion: "failure" };
}

/** Build a still-running CI run by name. */
function pendingRun(name: string): CIRun {
  return { name, conclusion: null };
}

/** Bodies that together satisfy `allReviewsPosted`. */
function allFiveReviewBodies(): string[] {
  return REVIEW_AGENT_HEADERS.map(
    (header) => `${header}\n\nAPPROVED — looks good.`,
  );
}

/** A Review Summary body that marks the PR ready to merge. */
function readyToMergeSummary(): string {
  return [
    REVIEW_SUMMARY_HEADER,
    "",
    "| Agent | Verdict | Blocking? |",
    "|-------|---------|-----------|",
    "| Arch | APPROVED | No |",
    "| DX | APPROVED | No |",
    "| Security | APPROVED | No |",
    "| Perf | APPROVED | No |",
    "| Test | APPROVED | No |",
    "",
    "5/5 agents approved.",
    "",
    READY_TO_MERGE_MARKER,
    "",
    "All green.",
  ].join("\n");
}

/** A Review Summary body that lists blocking issues. */
function blockingSummary(): string {
  return [
    REVIEW_SUMMARY_HEADER,
    "",
    "4/5 agents approved.",
    "",
    BLOCKING_ISSUES_MARKER,
    "",
    "**Perf — Rate limit errors bypass `[CLAW] Stopped` format**",
    "Wrap inspectRepo with a catch that intercepts rate-limit errors.",
  ].join("\n");
}

/**
 * Compose a {@link PRMonitorDeps} for a specific scenario. Every seam is a
 * static value by default so tests only override the field they care about.
 */
function buildDeps(overrides: {
  prMeta?: PRMetadata;
  commentBodies?: string[];
  ciRuns?: CIRun[];
  readPRMetadata?: PRMonitorDeps["readPRMetadata"];
  listPRCommentBodies?: PRMonitorDeps["listPRCommentBodies"];
  listCIRuns?: PRMonitorDeps["listCIRuns"];
} = {}): PRMonitorDeps {
  return {
    readPRMetadata:
      overrides.readPRMetadata ?? (async () => overrides.prMeta ?? meta()),
    listPRCommentBodies:
      overrides.listPRCommentBodies ??
      (async () => overrides.commentBodies ?? allFiveReviewBodies()),
    listCIRuns:
      overrides.listCIRuns ?? (async () => overrides.ciRuns ?? []),
  };
}

describe("hasFailingRun", () => {
  it("is true for any failing conclusion", () => {
    expect(hasFailingRun([successRun("Lint"), failureRun("Tests")])).toBe(true);
    expect(hasFailingRun([{ name: "X", conclusion: "timed_out" }])).toBe(true);
    expect(hasFailingRun([{ name: "X", conclusion: "cancelled" }])).toBe(true);
    expect(hasFailingRun([{ name: "X", conclusion: "action_required" }])).toBe(
      true,
    );
  });

  it("is false when every run is success / neutral / skipped", () => {
    expect(
      hasFailingRun([
        { name: "A", conclusion: "success" },
        { name: "B", conclusion: "neutral" },
        { name: "C", conclusion: "skipped" },
      ]),
    ).toBe(false);
  });

  it("treats still-running (conclusion=null) as not failing", () => {
    expect(hasFailingRun([pendingRun("Lint"), successRun("Tests")])).toBe(
      false,
    );
  });

  it("is false for an empty list", () => {
    expect(hasFailingRun([])).toBe(false);
  });
});

describe("allReviewsPosted", () => {
  it("is true when every review header appears", () => {
    expect(allReviewsPosted(allFiveReviewBodies())).toBe(true);
  });

  it("is false when any single header is missing", () => {
    const bodies = REVIEW_AGENT_HEADERS.slice(0, -1).map(
      (header) => `${header}\n\nAPPROVED`,
    );
    expect(allReviewsPosted(bodies)).toBe(false);
  });

  it("tolerates leading whitespace in the comment body", () => {
    const padded = REVIEW_AGENT_HEADERS.map(
      (header) => `   \n${header}\n\nAPPROVED`,
    );
    expect(allReviewsPosted(padded)).toBe(true);
  });

  it("is false on an empty list", () => {
    expect(allReviewsPosted([])).toBe(false);
  });
});

describe("latestReviewSummary", () => {
  it("returns null when no summary exists", () => {
    expect(latestReviewSummary(["## Arch Review\n\nAPPROVED"])).toBeNull();
  });

  it("returns the latest summary when multiple have been posted", () => {
    const first = `${REVIEW_SUMMARY_HEADER}\n\n${BLOCKING_ISSUES_MARKER}\n`;
    const second = `${REVIEW_SUMMARY_HEADER}\n\n${READY_TO_MERGE_MARKER}\n`;
    expect(latestReviewSummary([first, second])).toBe(second);
  });

  it("ignores non-summary comments between summaries", () => {
    const stale = `${REVIEW_SUMMARY_HEADER}\n\n${BLOCKING_ISSUES_MARKER}`;
    const chat = "Some random comment body.";
    const fresh = `${REVIEW_SUMMARY_HEADER}\n\n${READY_TO_MERGE_MARKER}`;
    expect(latestReviewSummary([stale, chat, fresh])).toBe(fresh);
  });

  it("tolerates leading whitespace before the header", () => {
    const body = `   \n${REVIEW_SUMMARY_HEADER}\n\n${READY_TO_MERGE_MARKER}`;
    expect(latestReviewSummary([body])).toBe(body);
  });
});

describe("getPRVerdict", () => {
  it("returns 'ci-failing' when any CI check is failing, even with approvals", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        commentBodies: [...allFiveReviewBodies(), readyToMergeSummary()],
        ciRuns: [successRun("Lint"), failureRun("Tests")],
      }),
    );
    expect(verdict).toBe("ci-failing");
  });

  it("returns 'pending' when no comments have been posted yet", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({ commentBodies: [], ciRuns: [] }),
    );
    expect(verdict).toBe("pending");
  });

  it("returns 'pending' when only some review agents have posted", async () => {
    const partial = REVIEW_AGENT_HEADERS.slice(0, 3).map(
      (header) => `${header}\n\nAPPROVED`,
    );
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({ commentBodies: partial }),
    );
    expect(verdict).toBe("pending");
  });

  it("returns 'pending' when all five agents have posted but no summary yet", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({ commentBodies: allFiveReviewBodies() }),
    );
    expect(verdict).toBe("pending");
  });

  it("returns 'changes-requested' when the latest summary has blocking issues", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        commentBodies: [...allFiveReviewBodies(), blockingSummary()],
      }),
    );
    expect(verdict).toBe("changes-requested");
  });

  it("returns 'changes-requested' even when mergeable_state is clean", async () => {
    // Blocking is about reviewer verdict, not GitHub's mergeability —
    // a clean mergeable_state must never promote blocking to approved.
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ mergeableState: "clean" }),
        commentBodies: [...allFiveReviewBodies(), blockingSummary()],
      }),
    );
    expect(verdict).toBe("changes-requested");
  });

  it("returns 'pending' when the summary contains neither marker", async () => {
    const vague = `${REVIEW_SUMMARY_HEADER}\n\nThinking...`;
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        commentBodies: [...allFiveReviewBodies(), vague],
      }),
    );
    expect(verdict).toBe("pending");
  });

  it("returns 'approved' when CI is green, all five reviews posted, summary ready, and mergeable_state is clean", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ mergeableState: "clean" }),
        commentBodies: [...allFiveReviewBodies(), readyToMergeSummary()],
        ciRuns: [
          successRun("Lint"),
          successRun("Type Check"),
          successRun("Tests"),
        ],
      }),
    );
    expect(verdict).toBe("approved");
  });

  it("returns 'pending' when ready-to-merge but mergeable_state is still unknown", async () => {
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ mergeableState: "unknown" }),
        commentBodies: [...allFiveReviewBodies(), readyToMergeSummary()],
      }),
    );
    expect(verdict).toBe("pending");
  });

  it.each(["blocked", "behind", "dirty", "unstable", "draft", ""])(
    "returns 'pending' when mergeable_state is %s",
    async (state) => {
      const verdict = await getPRVerdict(
        stubClient,
        REPO,
        PR,
        buildDeps({
          prMeta: meta({ mergeableState: state }),
          commentBodies: [...allFiveReviewBodies(), readyToMergeSummary()],
        }),
      );
      expect(verdict).toBe("pending");
    },
  );

  it("uses the PR head SHA when fetching CI runs", async () => {
    const seenShas: string[] = [];
    const listCIRuns = vi.fn(async (_ref, headSha: string) => {
      seenShas.push(headSha);
      return [] as CIRun[];
    });
    await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ headSha: "sha-from-pr" }),
        commentBodies: allFiveReviewBodies(),
        listCIRuns,
      }),
    );
    expect(seenShas).toEqual(["sha-from-pr"]);
  });

  it("prefers the most recent summary after a fix cycle re-runs the review", async () => {
    // First round flagged blocking; after the fix, the second summary clears it.
    const stale = `${REVIEW_SUMMARY_HEADER}\n\n${BLOCKING_ISSUES_MARKER}\nOld verdict.`;
    const fresh = readyToMergeSummary();
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ mergeableState: "clean" }),
        commentBodies: [...allFiveReviewBodies(), stale, fresh],
      }),
    );
    expect(verdict).toBe("approved");
  });

  it("prefers the most recent summary when a later round flags blocking issues", async () => {
    // Approved once, but a subsequent review found new issues — the
    // orchestrator must react to the latest state, not the first one.
    const old = `${REVIEW_SUMMARY_HEADER}\n\n${READY_TO_MERGE_MARKER}`;
    const fresh = `${REVIEW_SUMMARY_HEADER}\n\n${BLOCKING_ISSUES_MARKER}`;
    const verdict = await getPRVerdict(
      stubClient,
      REPO,
      PR,
      buildDeps({
        prMeta: meta({ mergeableState: "clean" }),
        commentBodies: [...allFiveReviewBodies(), old, fresh],
      }),
    );
    expect(verdict).toBe("changes-requested");
  });

  it("rejects an invalid repo string before any API call", async () => {
    const listCIRuns = vi.fn(async () => [] as CIRun[]);
    await expect(
      getPRVerdict(stubClient, "not-a-repo", PR, {
        readPRMetadata: async () => meta(),
        listPRCommentBodies: async () => [],
        listCIRuns,
      }),
    ).rejects.toBeInstanceOf(ClawError);
    expect(listCIRuns).not.toHaveBeenCalled();
  });

  it("translates GitHub rate-limit errors into a formatted ClawError", async () => {
    const rateLimitError = {
      status: 429,
      response: { headers: { "x-ratelimit-reset": "1700000000" } },
    };
    await expect(
      getPRVerdict(stubClient, REPO, PR, {
        readPRMetadata: async () => {
          throw rateLimitError;
        },
      }),
    ).rejects.toMatchObject({
      name: "ClawError",
      message: "GitHub API rate limit reached.",
    });
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    const boom = new Error("GitHub is down");
    await expect(
      getPRVerdict(stubClient, REPO, PR, {
        readPRMetadata: async () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
  });

  it("passes the resolved RepoRef to every injected seam", async () => {
    const readPRMetadata = vi.fn(async () => meta());
    const listPRCommentBodies = vi.fn(async () => allFiveReviewBodies());
    const listCIRuns = vi.fn(async () => [] as CIRun[]);
    await getPRVerdict(stubClient, REPO, PR, {
      readPRMetadata,
      listPRCommentBodies,
      listCIRuns,
    });
    const expectedRef = { owner: "pA1nD", repo: "claw-studio" };
    expect(readPRMetadata).toHaveBeenCalledWith(expectedRef, PR);
    expect(listPRCommentBodies).toHaveBeenCalledWith(expectedRef, PR);
    expect(listCIRuns).toHaveBeenCalledWith(expectedRef, HEAD_SHA);
  });
});
