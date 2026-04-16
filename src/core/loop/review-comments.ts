import type { Octokit } from "@octokit/rest";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import { withRateLimitHandling } from "../github/rate-limit.js";
import { REVIEW_AGENT_HEADERS } from "../checks/types.js";
import {
  REVIEW_SUMMARY_HEADER,
  BLOCKING_ISSUES_MARKER,
} from "../agents/pr-monitor.js";
import type { ReviewComment } from "../agents/context.js";

/** A raw PR comment as surfaced by the GitHub issues-comments endpoint. */
export interface RawPRComment {
  /** Full markdown body of the comment. */
  body: string;
  /** Author login (review agents post under their app's name). */
  author: string;
}

/** Dependencies injected into {@link fetchBlockingReviewComments}. */
export interface FetchReviewCommentsDeps {
  /** Return every top-level PR comment, in chronological order. */
  listPRComments?: (
    ref: RepoRef,
    prNumber: number,
  ) => Promise<RawPRComment[]>;
}

/**
 * Marker review agents include in a comment body to signal a blocking
 * verdict. Mirrors the prompts in `src/core/templates/ci.yml` — when the
 * agent prompt changes, this constant must change with it.
 */
export const CHANGES_REQUESTED_MARKER = "CHANGES REQUESTED";

/**
 * Fetch the blocking review comments the implementation agent must address on
 * the next fix cycle.
 *
 * Two filters are applied so the agent never sees noise:
 *
 *   1. The comment body must START with one of the {@link REVIEW_AGENT_HEADERS}
 *      — i.e. it is one of the five review agents' verdicts, not an unrelated
 *      drive-by comment.
 *   2. The comment body must contain {@link CHANGES_REQUESTED_MARKER} — only
 *      blocking verdicts feed into the fix prompt; APPROVED ones are skipped.
 *
 * The Review Summary comment ("## Review Summary") is intentionally excluded —
 * the orchestrator already consults the summary via the PR monitor's verdict;
 * passing it back in the fix prompt would just duplicate context.
 *
 * Fix cycles trigger a fresh run of the review agents. Earlier rounds' verdicts
 * are kept in the result list because they describe the trajectory the agent
 * needs to be aware of: a comment that was "BLOCKING" in round 1 may have
 * been resolved in round 2's APPROVED — only the most recent run actually
 * blocks, so the agent can prioritise accordingly.
 *
 * @param client    an Octokit client produced by `createClient()`
 * @param repo      target repository in `owner/repo` form
 * @param prNumber  the PR awaiting fixes
 * @param deps      optional injected seams for testing
 * @returns blocking review comments, in PR-comment order
 * @throws {ClawError} when the GitHub API rate limit is exhausted
 */
export async function fetchBlockingReviewComments(
  client: Octokit,
  repo: string,
  prNumber: number,
  deps: FetchReviewCommentsDeps = {},
): Promise<ReviewComment[]> {
  const ref = parseRepoString(repo);
  const listComments =
    deps.listPRComments ?? buildDefaultListPRComments(client);

  return withRateLimitHandling(async () => {
    const comments = await listComments(ref, prNumber);
    return comments
      .filter((c) => isReviewAgentComment(c.body))
      .filter((c) => !isReviewSummaryComment(c.body))
      .filter((c) => c.body.includes(CHANGES_REQUESTED_MARKER))
      .map<ReviewComment>((c) => ({ author: c.author, body: c.body }));
  });
}

/** True when `body` starts with one of the five review-agent headers. */
export function isReviewAgentComment(body: string): boolean {
  const trimmed = body.trimStart();
  return REVIEW_AGENT_HEADERS.some((header) => trimmed.startsWith(header));
}

/** True when `body` is the summary job's roll-up comment. */
export function isReviewSummaryComment(body: string): boolean {
  // Use the same prefix-with-trim matcher as the PR monitor and CHECK 10 so
  // the orchestrator and the merge gate agree on what counts as the summary.
  const trimmed = body.trimStart();
  return trimmed.startsWith(REVIEW_SUMMARY_HEADER);
}

/**
 * Re-export `BLOCKING_ISSUES_MARKER` so the orchestrator's tests can pin the
 * marker against the same constant the PR monitor uses.
 */
export { BLOCKING_ISSUES_MARKER };

/**
 * Build the default PR-comment lister — paginates `issues.listComments` (the
 * GitHub endpoint that serves PR conversations), mirroring the PR monitor.
 *
 * Wraps the paginated call in `withRateLimitHandling` so a rate-limit hit
 * during the fix cycle's comment fetch surfaces as the standard `[CLAW]
 * Stopped — GitHub API rate limit reached.` error with a reset-time hint —
 * matching the pattern every other default API seam in the loop module uses.
 */
function buildDefaultListPRComments(
  client: Octokit,
): (ref: RepoRef, prNumber: number) => Promise<RawPRComment[]> {
  return async (ref, prNumber) =>
    withRateLimitHandling(async () => {
      const rows = await client.paginate(client.issues.listComments, {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: prNumber,
        per_page: 100,
      });
      return rows.map((row) => ({
        body: row.body ?? "",
        author: row.user?.login ?? "unknown",
      }));
    });
}
