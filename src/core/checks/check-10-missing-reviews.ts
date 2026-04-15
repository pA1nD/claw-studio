import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";
import { REVIEW_AGENT_HEADERS, isClawPullRequest } from "./types.js";
import type { CheckResult, PullRequestInfo } from "./types.js";

/** Dependencies injected into CHECK 10. */
export interface Check10Deps {
  /**
   * Read every issue / PR comment body for a PR. The default fans out to
   * `issues.listComments` (review-agent comments are issue-level, not
   * inline review comments).
   */
  listPRCommentBodies?: (
    ref: RepoRef,
    prNumber: number,
  ) => Promise<string[]>;
}

/**
 * CHECK 10 — Every open `claw/` PR has either all five or zero review
 * comments — never a partial set.
 *
 * The five review agents fire in parallel from `ci.yml`. A partial set means
 * one or more crashed and never posted, which leaves the PR unmergeable
 * because the merge gate (`Review Summary`) waits for all five before voting.
 *
 * Zero comments is OK — the agents may simply not have started yet. The
 * orchestrator's PR monitor (issue #4) handles the "still pending" case.
 *
 * @param client   an Octokit client produced by `createClient()`
 * @param ref      the target repository
 * @param openPRs  every open PR on the repo
 * @param deps     optional injected seam for testing
 * @returns {@link CheckResult} — fails on the first PR with partial reviews
 */
export async function check10MissingReviews(
  client: Octokit,
  ref: RepoRef,
  openPRs: readonly PullRequestInfo[],
  deps: Check10Deps = {},
): Promise<CheckResult> {
  const listBodies =
    deps.listPRCommentBodies ?? buildDefaultListComments(client);

  for (const pr of openPRs) {
    if (!isClawPullRequest(pr)) continue;

    const bodies = await listBodies(ref, pr.number);
    const present = REVIEW_AGENT_HEADERS.filter((header) =>
      bodies.some((body) => body.trimStart().startsWith(header)),
    );

    if (present.length === 0) continue; // Pending — handled by the PR monitor.
    if (present.length === REVIEW_AGENT_HEADERS.length) continue; // Complete.

    const missing = REVIEW_AGENT_HEADERS.filter((header) => !present.includes(
      header,
    ))
      .map(stripHeaderPrefix)
      .join(", ");

    return {
      passed: false,
      error: new ClawError(
        `PR #${pr.number} is missing reviews from: ${missing}.`,
        "Push an empty commit to re-trigger CI.",
      ),
    };
  }
  return { passed: true };
}

/** Strip the markdown prefix so the missing-agent list reads cleanly. */
function stripHeaderPrefix(header: string): string {
  // "## Arch Review" → "Arch Review". Defensive — works whether the header
  // happens to be sourced with extra whitespace or not.
  return header.replace(/^##\s+/, "");
}

/**
 * Build the default Octokit-backed comments fetcher.
 *
 * Review-agent comments are top-level PR comments (the underlying GitHub
 * model is "issue comments" — the same endpoint serves PRs). `paginate` so
 * a long discussion thread doesn't silently truncate the result.
 */
function buildDefaultListComments(
  client: Octokit,
): (ref: RepoRef, prNumber: number) => Promise<string[]> {
  return async (ref, prNumber) => {
    const rows = await client.paginate(client.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return rows.map((row) => row.body ?? "");
  };
}
