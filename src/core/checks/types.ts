import type { ClawError } from "../types/errors.js";

/**
 * The shape every individual check returns.
 *
 * Discriminated by `passed` so callers cannot accidentally read `error` from a
 * passing result or forget to provide it from a failing one.
 *
 *   { passed: true }                                       → continue to the next check
 *   { passed: false, error: ClawError }                    → halt the loop, render error
 *   { passed: false, error: ClawError, terminal: true }    → milestone done, pause cleanly
 */
export type CheckResult =
  | { passed: true }
  | { passed: false; error: ClawError; terminal?: boolean };

/**
 * Minimal branch metadata the inspector needs.
 *
 * Kept narrower than Octokit's response shape so tests don't have to construct
 * the full `BranchWithProtection` payload. The inspector populates this from
 * `repos.listBranches`.
 */
export interface BranchInfo {
  /** Branch name (e.g. `"claw/issue-2-repo-state-inspector"`). */
  name: string;
  /** Tip commit SHA — used for compare-commits in CHECK 9. */
  sha: string;
}

/**
 * Minimal pull-request metadata the inspector needs.
 *
 * The inspector populates this from `pulls.list` (state=open). Only the fields
 * we actually consume in checks 7-13 are surfaced — anything richer belongs
 * in the PR monitor (issue #4).
 */
export interface PullRequestInfo {
  /** PR number. */
  number: number;
  /** PR title. */
  title: string;
  /** PR body — searched for `Closes #N` in CHECK 7. Empty string when GitHub returns `null`. */
  body: string;
  /** The branch the PR is opened FROM (head ref, no `refs/heads/` prefix). */
  headRef: string;
  /** The branch the PR is targeting (base ref, no `refs/heads/` prefix). */
  baseRef: string;
  /** Tip commit SHA of the head branch — used by CHECK 12 to look up CI runs. */
  headSha: string;
}

/**
 * The persisted state for an in-flight implementation agent session.
 *
 * Lives at `.claw/sessions/{N}.json`. Read by CHECK 11 to detect when an
 * issue has been through too many failed fix attempts.
 *
 * Owned by the implementation agent (issue #3) — the inspector only reads it.
 */
export interface SessionFile {
  /** Issue number this session is implementing. */
  issueNumber: number;
  /** Claude Code session ID (used to resume on fix cycles). */
  sessionId: string;
  /** How many fix attempts have been made on this issue. Escalates at 3. */
  fixAttempts: number;
}

/** All branches managed by the loop start with this prefix. */
export const CLAW_BRANCH_PREFIX = "claw/";

/** Label that signals "the implementation agent gave up — please resolve manually". */
export const NEEDS_HUMAN_LABEL = "needs-human";

/**
 * The five review-agent comment headers the inspector looks for on each PR.
 *
 * Mirrors the prompts in `src/core/templates/ci.yml` — when the agent prompt
 * changes, this constant must change with it. Each agent posts a top-level
 * PR comment that begins with its header line; CHECK 10 detects when some
 * but not all five are present.
 */
export const REVIEW_AGENT_HEADERS: readonly string[] = [
  "## Arch Review",
  "## DX Review",
  "## Security Review",
  "## Perf Review",
  "## Test Review",
];

/**
 * Threshold beyond which the implementation agent escalates to `needs-human`.
 *
 * Owned by the implementation agent (issue #3); duplicated here so CHECK 11
 * can detect the boundary independently. Kept in lockstep — if the agent
 * raises the limit, this constant moves with it.
 */
export const MAX_FIX_ATTEMPTS = 3;

/** True when a branch name is owned by the loop (prefixed `claw/`). */
export function isClawBranch(name: string): boolean {
  return name.startsWith(CLAW_BRANCH_PREFIX);
}

/** True when a PR was opened from a loop-owned branch. */
export function isClawPullRequest(pr: PullRequestInfo): boolean {
  return isClawBranch(pr.headRef);
}

/**
 * Match GitHub's auto-close keywords (`closes`/`fixes`/`resolves`) followed by
 * an issue reference. Captured group is the digit run.
 *
 * Single source of truth for "what counts as a linked issue" — used by
 * CHECK 5, 7, 11, and 13.
 */
const CLOSING_KEYWORD_REGEX = /(?:closes|fixes|resolves)\s+#(\d+)\b/i;

/**
 * Extract the linked issue number from a PR body, or `null` when no closing
 * keyword + issue reference is present.
 *
 * @param body PR body — accepts an empty string for missing bodies
 * @returns the first issue number referenced, or null
 */
export function extractLinkedIssueNumber(body: string): number | null {
  const match = body.match(CLOSING_KEYWORD_REGEX);
  if (!match || !match[1]) return null;
  return Number.parseInt(match[1], 10);
}

/** True when a PR body contains a recognised closing keyword + issue reference. */
export function hasLinkedIssue(body: string): boolean {
  return extractLinkedIssueNumber(body) !== null;
}
