/**
 * Types for the repo state inspector.
 *
 * The inspector is the first thing the loop runs on every cycle. Every check
 * it runs returns a {@link CheckResult} — passed, or failed with an explicit,
 * human-readable error. Nothing here performs mutations.
 */
import type { ClawError } from "../types/errors.js";
import type { Milestone } from "../roadmap/parser.js";
import type { RepoRef } from "../github/repo-detect.js";

/**
 * Outcome of a single ordered check.
 *
 * `passed` is the primary field. When `passed` is `false`, `error` MUST be set
 * and describe what is wrong. `terminal` is reserved for happy-path
 * termination — e.g. "every issue in the milestone is closed, nothing left to
 * do" — so the loop can pause-and-notify instead of surfacing a red error.
 */
export interface CheckResult {
  /** True when the check passed. */
  passed: boolean;
  /** Error explaining what went wrong. Required whenever `passed` is false. */
  error?: ClawError;
  /**
   * True when the failure represents a happy-path stop (all work done) rather
   * than a problem. The loop pauses and notifies instead of halting.
   */
  terminal?: boolean;
}

/** An `owner/repo` reference plus the inspector snapshot. */
export interface RepoState {
  /** Target repository. */
  ref: RepoRef;
  /** Current milestone, already parsed from ROADMAP.md. */
  milestone: Milestone;
  /** Default branch name of the target repo. */
  defaultBranch: string;
  /** All `claw/` branch names currently on the remote (open or not). */
  clawBranches: string[];
  /** Map of `claw/` branch name → commits behind the default branch. */
  branchBehind: Record<string, number>;
  /** Every open PR whose head ref starts with `claw/`. */
  openPullRequests: PullRequestSummary[];
  /** Local session files keyed by issue number. */
  sessions: Record<number, SessionRecord>;
}

/** A trimmed summary of an open PR — only the fields the inspector reads. */
export interface PullRequestSummary {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** PR body — empty string when the API returns null. */
  body: string;
  /** Head branch ref (e.g. `claw/issue-7-foo`). */
  headRef: string;
  /** Base branch ref (e.g. `main`). */
  baseRef: string;
  /**
   * Issue number referenced by a `Closes #N` / `Fixes #N` / `Resolves #N`
   * marker in the PR body, or `null` when no such marker is present.
   */
  linkedIssue: number | null;
  /** Verdicts posted by the review agents. */
  reviews: ReviewVerdict[];
  /** Status check rollup for the head ref. */
  statusChecks: StatusCheckSummary[];
}

/** A single review verdict — one per reviewer. */
export interface ReviewVerdict {
  /** Review agent name (e.g. `"Arch"`, `"Security"`, `"Review Summary"`). */
  agent: string;
  /** What the agent decided. `"PENDING"` means the agent has not posted yet. */
  verdict: "APPROVED" | "CHANGES REQUESTED" | "PENDING";
}

/** A trimmed status-check row — only the fields we care about. */
export interface StatusCheckSummary {
  /** Check name — matches the workflow job `name:`. */
  name: string;
  /**
   * Final conclusion once the check has finished, or `null` when the check
   * is still running / queued. We treat `null` as "not yet failing" — we do
   * not block the loop for in-flight checks.
   */
  conclusion: string | null;
}

/** Local session file — one per in-flight issue. */
export interface SessionRecord {
  /** The issue this session is implementing. */
  issueNumber: number;
  /** Session id used by `claude -p --resume`. */
  sessionId: string;
  /** How many times the fix agent has already run against this issue. */
  fixAttempts: number;
}
