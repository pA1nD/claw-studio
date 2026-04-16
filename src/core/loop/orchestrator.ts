import { Buffer } from "node:buffer";
import type { Octokit } from "@octokit/rest";
import { ClawError, isClawError } from "../types/errors.js";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import { withRateLimitHandling } from "../github/rate-limit.js";
import { parseRoadmap } from "../roadmap/parser.js";
import type { Issue, Milestone, ParseRoadmapDeps } from "../roadmap/parser.js";
import { inspectRepo } from "../checks/inspector.js";
import type { InspectorDeps } from "../checks/inspector.js";
import {
  extractLinkedIssueNumber,
  isClawPullRequest,
} from "../checks/types.js";
import type { PullRequestInfo } from "../checks/types.js";
import { getPRVerdict } from "../agents/pr-monitor.js";
import type { PRVerdict } from "../agents/pr-monitor.js";
import {
  runFixCycle,
  runImplementationAgent,
} from "../agents/implementation.js";
import type { ImplementationAgentDeps } from "../agents/implementation.js";
import { deleteSession } from "../agents/session.js";
import type { SessionFs } from "../agents/session.js";
import { deleteBranch, squashMerge } from "../git/operations.js";
import { resolveSetupPaths } from "../setup/paths.js";
import type { ClawConfig } from "../setup/config.js";
import {
  fetchBlockingReviewComments,
  type FetchReviewCommentsDeps,
} from "./review-comments.js";
import { toClawError } from "./safe-error.js";

/**
 * The discriminated outcome of a single loop cycle.
 *
 * Every variant is intentionally tiny: just enough for the caller to log it,
 * decide whether to keep polling, and render the right Ink view. No raw
 * Octokit data, no PR shapes, no agent internals — keeping the surface narrow
 * means a future change to the inspector or agents cannot ripple into every
 * caller of `runCycle`.
 */
export type CycleResult =
  | {
      /** A real change was made (PR opened, merged, fixed). */
      type: "action-taken";
      /** Human-readable line for the log and the dashboard. */
      action: string;
    }
  | {
      /** The cycle ran successfully but there is nothing to do — keep polling. */
      type: "waiting";
      /** Human-readable reason. */
      reason: string;
    }
  | {
      /** The loop must halt — render the error and surface it to the human. */
      type: "halted";
      /** Always a {@link ClawError} so {@link toClawError} has already redacted secrets. */
      error: ClawError;
    }
  | {
      /** The current milestone is fully shipped — pause and wait for confirmation. */
      type: "milestone-complete";
      /** Milestone name (e.g. `"v0.1"`). */
      milestone: string;
    };

/** Default poll interval used when the config does not provide one. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** How long the loop sleeps between paused-flag polls (1 second). */
export const PAUSE_POLL_MS = 1_000;

/** Idle threshold — the loop emits a warning after this much wall-clock with no action. */
export const IDLE_WARNING_MS = 30 * 60 * 1_000;

/**
 * How many times {@link runCycle} retries an inner cycle that throws a
 * non-{@link ClawError}. Spec: "GitHub API errors → log warning, retry with
 * exponential backoff (max 3 attempts)".
 *
 * Structured `ClawError`s are NOT retried — they describe deterministic
 * states the human must resolve (missing ROADMAP, no current milestone,
 * branch protection refusal) and a retry would not change the outcome.
 */
export const MAX_CYCLE_ATTEMPTS = 3;

/**
 * Dependencies the orchestrator delegates to. Every field is optional and
 * defaulted to a real Octokit-backed implementation; tests inject only the
 * seams they need to drive a specific cycle through a specific path.
 */
export interface OrchestratorDeps {
  /** Read `ROADMAP.md` from the target repo (default: GitHub `repos.getContent`). */
  readRoadmapContent?: (repo: string) => Promise<string>;
  /** List every open PR in the target repo (default: paginated `pulls.list`). */
  listOpenPullRequests?: (repo: string) => Promise<PullRequestInfo[]>;
  /** PR-verdict reader (default: {@link getPRVerdict}). */
  readPRVerdict?: (repo: string, prNumber: number) => Promise<PRVerdict>;
  /** Squash-merge a PR (default: {@link squashMerge}). */
  squashMerge?: (
    repo: string,
    prNumber: number,
    issueTitle: string,
    issueNumber: number,
  ) => Promise<{ sha: string }>;
  /** Delete a branch (default: {@link deleteBranch}). */
  deleteBranch?: (repo: string, branch: string) => Promise<void>;
  /** Spawn the implementation agent (default: {@link runImplementationAgent}). */
  runImplementationAgent?: typeof runImplementationAgent;
  /** Resume the implementation agent for a fix cycle (default: {@link runFixCycle}). */
  runFixCycle?: typeof runFixCycle;
  /** Fetch the blocking review comments for a PR (default: {@link fetchBlockingReviewComments}). */
  fetchReviewComments?: (
    repo: string,
    prNumber: number,
  ) => Promise<Awaited<ReturnType<typeof fetchBlockingReviewComments>>>;
  /** Delete a session file (default: {@link deleteSession}). */
  deleteSession?: (cwd: string, issueNumber: number) => Promise<void>;
  /** Optional dependency seams the implementation agent forwards through. */
  agent?: ImplementationAgentDeps;
  /** Optional filesystem seam for session reads/writes inside the agent. */
  sessionFs?: SessionFs;
  /** Inspector deps (default: live Octokit-backed checks). */
  inspector?: InspectorDeps;
  /** Roadmap-parser deps (default: live Octokit-backed reader). */
  roadmap?: ParseRoadmapDeps;
  /** Review-comments deps (only used when `fetchReviewComments` is not overridden). */
  reviewComments?: FetchReviewCommentsDeps;
}

/** Options accepted by {@link runCycle}. */
export interface RunCycleOptions {
  /** Working directory of the target project (where `.claw/` lives). Defaults to `process.cwd()`. */
  cwd?: string;
  /** Optional injected dependencies for testing. */
  deps?: OrchestratorDeps;
  /**
   * Sleep helper used by the retry-with-backoff layer. Defaults to a
   * `setTimeout` Promise wrapper. Tests inject a no-op to keep `vitest` runs
   * fast — no real wall-clock waits during the unit suite.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run a single loop cycle.
 *
 * The cycle is the unit `claw status` re-uses: parse the roadmap, inspect repo
 * state, and (if the inspector passed) decide on exactly one action — open a
 * PR, merge it, run a fix, or wait. Errors are surfaced as
 * `{ type: "halted", error }` so callers never see a raw throwable; the
 * security carry-forward from PR #27 / PR #28 (don't serialize raw Octokit
 * errors that carry the `Authorization` header) is enforced in one place via
 * {@link toClawError}.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param config the parsed `.claw/config.json`
 * @param options optional cwd + injected deps
 * @returns the cycle outcome — never throws
 */
export async function runCycle(
  client: Octokit,
  config: ClawConfig,
  options: RunCycleOptions = {},
): Promise<CycleResult> {
  const cwd = options.cwd ?? process.cwd();
  const deps = options.deps ?? {};
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= MAX_CYCLE_ATTEMPTS; attempt += 1) {
    try {
      return await runCycleInner(client, config, cwd, deps);
    } catch (err) {
      // Structured failures describe deterministic states — retrying would
      // not change the outcome, so halt immediately.
      if (isClawError(err)) {
        return { type: "halted", error: err };
      }
      // Last attempt — translate the raw error and halt.
      if (attempt === MAX_CYCLE_ATTEMPTS) {
        return { type: "halted", error: toClawError(err) };
      }
      // Exponential backoff: 2s, 4s, 8s, 16s, … (capped by attempt count).
      // The backoff is intentionally synchronous within the cycle so the
      // human sees one halt per cycle, not three.
      await sleep(2 ** attempt * 1_000);
    }
  }
  // Unreachable — the loop above exhausts via the `attempt === MAX` branch.
  return {
    type: "halted",
    error: new ClawError("retry budget exhausted."),
  };
}

/** Default sleep — `setTimeout` Promise wrapper. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Inner cycle that may throw. {@link runCycle} wraps this and converts every
 * uncaught error into the `halted` variant via {@link toClawError}.
 */
async function runCycleInner(
  client: Octokit,
  config: ClawConfig,
  cwd: string,
  deps: OrchestratorDeps,
): Promise<CycleResult> {
  // Validate the repo string up front so a malformed config halts here
  // rather than deep inside the inspector / agent.
  parseRepoString(config.repo);

  // 1. Read the roadmap to know which milestone we're working on. Errors here
  //    surface as halts because the loop has nothing to do without a
  //    milestone.
  const milestone = await parseRoadmap(client, config.repo, deps.roadmap);

  // 2. Inspect repo state. Halt on any failure; treat the milestone-complete
  //    terminal state as a clean pause.
  const inspection = await inspectRepo(client, config.repo, {
    cwd,
    deps: deps.inspector,
  });
  if (!inspection.passed) {
    if (inspection.terminal) {
      return { type: "milestone-complete", milestone: milestone.name };
    }
    return { type: "halted", error: inspection.error };
  }

  // 3. Pick the action.
  const listOpenPRs =
    deps.listOpenPullRequests ?? buildDefaultListOpenPRs(client);
  const openPRs = await listOpenPRs(config.repo);
  const inFlight = openPRs.find(isClawPullRequest) ?? null;

  if (inFlight === null) {
    return await spawnNextIssue(client, config, milestone, cwd, deps);
  }
  return await actOnOpenPR(client, config, inFlight, milestone, cwd, deps);
}

/** Spawn the implementation agent on the lowest-numbered open issue. */
async function spawnNextIssue(
  client: Octokit,
  config: ClawConfig,
  milestone: Milestone,
  cwd: string,
  deps: OrchestratorDeps,
): Promise<CycleResult> {
  const next = findLowestOpenIssue(milestone.issues);
  if (next === null) {
    // CHECK 4 should have caught this — defensive only.
    return { type: "milestone-complete", milestone: milestone.name };
  }

  const readRoadmap =
    deps.readRoadmapContent ?? buildDefaultReadRoadmap(client);
  const roadmap = await readRoadmap(config.repo);

  const spawn = deps.runImplementationAgent ?? runImplementationAgent;
  const agentDeps = mergeAgentDeps(deps);
  const outcome = await spawn(client, {
    issue: next,
    cwd,
    milestoneName: milestone.name,
    milestoneIssues: milestone.issues,
    repo: config.repo,
    roadmap,
    deps: agentDeps,
  });

  return {
    type: "action-taken",
    action: `opened PR #${outcome.prNumber} for issue #${next.number} on ${outcome.branch}`,
  };
}

/** Read the verdict on the open PR and dispatch the right action. */
async function actOnOpenPR(
  client: Octokit,
  config: ClawConfig,
  pr: PullRequestInfo,
  milestone: Milestone,
  cwd: string,
  deps: OrchestratorDeps,
): Promise<CycleResult> {
  const readVerdict =
    deps.readPRVerdict ?? ((repo, prNumber) => getPRVerdict(client, repo, prNumber));
  const verdict = await readVerdict(config.repo, pr.number);

  switch (verdict) {
    case "pending":
      return {
        type: "waiting",
        reason: `PR #${pr.number} review pending`,
      };
    case "approved":
      return await mergeApproved(client, config, pr, milestone, cwd, deps);
    case "changes-requested":
      return await runFixForPR(client, config, pr, milestone, cwd, deps);
    case "ci-failing":
      // CHECK 12 should have already halted the cycle with the failing check
      // names; if we're here it means CHECK 12's seam disagreed with the PR
      // monitor's seam — a programming error worth surfacing rather than
      // silently retrying.
      return {
        type: "halted",
        error: new ClawError(
          `CI is failing on PR #${pr.number}.`,
          "Run `claw status` to see which checks failed, then fix and resume.",
        ),
      };
  }
}

/** Squash-merge an approved PR, delete its branch, and clean up the session. */
async function mergeApproved(
  client: Octokit,
  config: ClawConfig,
  pr: PullRequestInfo,
  milestone: Milestone,
  cwd: string,
  deps: OrchestratorDeps,
): Promise<CycleResult> {
  const issue = resolveLinkedIssue(pr, milestone);
  if (issue === null) {
    return {
      type: "halted",
      error: new ClawError(
        `PR #${pr.number} does not link to a milestone ${milestone.name} issue.`,
        "Add a `Closes #N` reference to the PR body and ensure the linked issue carries the milestone label.",
      ),
    };
  }

  const merge =
    deps.squashMerge ??
    ((repo, prNumber, issueTitle, issueNumber) =>
      squashMerge(client, repo, prNumber, issueTitle, issueNumber));
  await merge(config.repo, pr.number, issue.title, issue.number);

  const remove =
    deps.deleteBranch ??
    ((repo, branch) => deleteBranch(client, repo, branch));
  await remove(config.repo, pr.headRef);

  // Session file is owned by the agent — sessions live for the duration of
  // the issue, so a successful merge is the right moment to clear it. The
  // delete is a no-op when the file is already gone (e.g. an escalation
  // cleared it on a previous cycle).
  const removeSession =
    deps.deleteSession ??
    ((sessionCwd, issueNumber) =>
      deleteSession(sessionCwd, issueNumber, deps.sessionFs));
  await removeSession(cwd, issue.number);

  return {
    type: "action-taken",
    action: `merged PR #${pr.number} for issue #${issue.number} (${issue.title})`,
  };
}

/** Resume the implementation session to address blocking review comments. */
async function runFixForPR(
  client: Octokit,
  config: ClawConfig,
  pr: PullRequestInfo,
  milestone: Milestone,
  cwd: string,
  deps: OrchestratorDeps,
): Promise<CycleResult> {
  const issue = resolveLinkedIssue(pr, milestone);
  if (issue === null) {
    return {
      type: "halted",
      error: new ClawError(
        `PR #${pr.number} does not link to a milestone ${milestone.name} issue.`,
        "Add a `Closes #N` reference to the PR body and ensure the linked issue carries the milestone label.",
      ),
    };
  }

  const fetchReviews =
    deps.fetchReviewComments ??
    ((repo, prNumber) =>
      fetchBlockingReviewComments(client, repo, prNumber, deps.reviewComments));
  const reviewComments = await fetchReviews(config.repo, pr.number);

  const fix = deps.runFixCycle ?? runFixCycle;
  const agentDeps = mergeAgentDeps(deps);
  const outcome = await fix(client, {
    issue,
    cwd,
    repo: config.repo,
    prNumber: pr.number,
    reviewComments,
    deps: agentDeps,
  });

  if (outcome.type === "escalated") {
    return {
      type: "action-taken",
      action: `escalated PR #${pr.number} after ${outcome.attemptsMade} fix attempt${outcome.attemptsMade === 1 ? "" : "s"} — labelled needs-human`,
    };
  }
  return {
    type: "action-taken",
    action: `fix attempt ${outcome.attemptNumber} pushed for PR #${pr.number}`,
  };
}

/** Find the lowest-numbered open issue, or null when none exist. */
export function findLowestOpenIssue(issues: readonly Issue[]): Issue | null {
  let lowest: Issue | null = null;
  for (const issue of issues) {
    if (issue.state !== "open") continue;
    if (lowest === null || issue.number < lowest.number) lowest = issue;
  }
  return lowest;
}

/**
 * Resolve the milestone issue a PR is implementing.
 *
 * Reads the `Closes #N` reference from the PR body via {@link extractLinkedIssueNumber}
 * (the same matcher CHECK 7 uses) and returns the matching milestone issue.
 * Returns null when the PR has no link or the link points outside the
 * milestone — both are caller-handled halts because the inspector should have
 * already caught them (CHECK 7, CHECK 13).
 *
 * @param pr        the open PR
 * @param milestone the resolved milestone
 * @returns the linked issue, or null
 */
export function resolveLinkedIssue(
  pr: PullRequestInfo,
  milestone: Milestone,
): Issue | null {
  const linkedNumber = extractLinkedIssueNumber(pr.body);
  if (linkedNumber === null) return null;
  return milestone.issues.find((i) => i.number === linkedNumber) ?? null;
}

/** Build the default open-PR lister — paginates `pulls.list` with `state=open`. */
function buildDefaultListOpenPRs(
  client: Octokit,
): (repo: string) => Promise<PullRequestInfo[]> {
  return async (repo) => {
    const ref = parseRepoString(repo);
    return withRateLimitHandling(async () => {
      const rows = await client.paginate(client.pulls.list, {
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        per_page: 100,
      });
      return rows.map((row) => ({
        number: row.number,
        title: row.title,
        body: row.body ?? "",
        headRef: row.head.ref,
        baseRef: row.base.ref,
        headSha: row.head.sha,
      }));
    });
  };
}

/** Build the default ROADMAP.md reader — calls `repos.getContent`. */
function buildDefaultReadRoadmap(
  client: Octokit,
): (repo: string) => Promise<string> {
  return async (repo) => {
    const ref = parseRepoString(repo);
    return withRateLimitHandling(async () => {
      const { data } = await client.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: "ROADMAP.md",
      });
      return decodeRoadmap(data, ref);
    });
  };
}

/** Decode a single-file response from `repos.getContent` into UTF-8 text. */
function decodeRoadmap(data: unknown, ref: RepoRef): string {
  if (Array.isArray(data) || typeof data !== "object" || data === null) {
    throw new ClawError(
      `unexpected ROADMAP.md response from ${ref.owner}/${ref.repo}.`,
      "Expected a single file payload — got a directory listing or null.",
    );
  }
  const shape = data as { content?: unknown; encoding?: unknown };
  if (typeof shape.content !== "string") {
    throw new ClawError(
      `ROADMAP.md from ${ref.owner}/${ref.repo} had no content.`,
      "Re-check that ROADMAP.md is committed to the default branch.",
    );
  }
  if (shape.encoding === "base64") {
    return Buffer.from(shape.content, "base64").toString("utf8");
  }
  return shape.content;
}

/**
 * Merge the orchestrator-level agent deps with the user's overrides into the
 * single `ImplementationAgentDeps` shape the agents accept. Lets a test pass
 * an `agent.priorReviewNotes` seam alongside an `agent.claude` seam without
 * having to construct the union manually.
 */
function mergeAgentDeps(
  deps: OrchestratorDeps,
): ImplementationAgentDeps | undefined {
  const agent = deps.agent;
  if (!agent && !deps.sessionFs) return undefined;
  return {
    ...(agent ?? {}),
    sessionFs: agent?.sessionFs ?? deps.sessionFs,
  };
}

/**
 * Resolve the absolute path of the target project's `.claw/` directory.
 *
 * Re-exported so the loop's CLI commands can reach it without importing the
 * setup module directly — keeps the surface for callers narrow.
 */
export function resolveClawDir(cwd: string): string {
  return resolveSetupPaths(cwd).clawDir;
}
