import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../github/repo-detect.js";

/** A single review-note excerpt harvested from a merged PR's comments. */
export interface PriorReviewNote {
  /** The merged PR the note came from. */
  prNumber: number;
  /** The comment the note came from — used to cite the source in the prompt. */
  commentUrl: string;
  /** Author login (the review agent that posted the comment). */
  author: string;
  /** Full comment body. */
  body: string;
}

/** Dependencies injected into {@link fetchPriorReviewNotes}. */
export interface FetchPriorReviewNotesDeps {
  /**
   * Return the PR numbers of every merged pull request that has been
   * cross-referenced on an issue.
   *
   * Callers MUST filter to `cross-referenced` timeline events whose source is
   * a merged PR. The default implementation does this via Octokit's timeline +
   * PR endpoints; tests inject a stub.
   */
  listCrossReferencedMergedPRs?: (
    ref: RepoRef,
    issueNumber: number,
  ) => Promise<number[]>;
  /**
   * Return every top-level issue comment for a PR. Review agents post their
   * verdicts as issue comments, so this is where prior review notes live.
   */
  listPRComments?: (
    ref: RepoRef,
    prNumber: number,
  ) => Promise<RawComment[]>;
}

/** Subset of a GitHub comment the fetcher consumes. */
export interface RawComment {
  body: string;
  author: string;
  url: string;
}

/**
 * Pattern that identifies a **standalone** `#N` reference — a match cannot be
 * adjacent to alphanumerics on either side, so:
 *
 *   - `#3` in `"check issue #3"`        → match
 *   - `#3` in `"step #3 in the list"`   → match
 *   - `#3` in `"v0.3"`                   → NO match (no `#` before `3`)
 *   - `#3` in `"#35"`                    → NO match (digit follows)
 *   - `#3` in `"foo#3"`                  → NO match (word-char before `#`)
 *
 * The issue spec requests exactly this: "find comments containing `#{N}` as a
 * standalone reference (not a list number or range)". The `(?<![\w#])` and
 * `(?![\w])` boundaries implement the "standalone" condition without
 * depending on language-specific word boundaries.
 *
 * @param issueNumber the issue number to match
 * @returns a regex that matches a standalone `#{issueNumber}`
 */
export function buildStandaloneReferenceRegex(issueNumber: number): RegExp {
  // No lookbehind for `#` itself is captured by `(?<!\w)` alone — we also
  // guard against `##3` because `##` is used as a Markdown heading marker and
  // appears often in review comments.
  return new RegExp(`(?<![\\w#])#${issueNumber}(?!\\w)`);
}

/**
 * Fetch prior review notes that reference a given issue number.
 *
 * Walks the GitHub timeline for the issue, collects every `cross-referenced`
 * event whose source is a merged PR, and returns every comment on those PRs
 * whose body contains a standalone `#{issueNumber}` reference. This feeds
 * directly into the implementation agent's context prompt — giving the agent
 * the institutional memory that earlier review agents accumulated.
 *
 * The function is pure read: no writes, no mutations, no side effects beyond
 * the GitHub API calls. Failures propagate unchanged — the caller decides
 * whether to halt the loop or continue without the notes.
 *
 * @param client       an Octokit client produced by `createClient()`
 * @param ref          target repository
 * @param issueNumber  the issue the agent is about to implement
 * @param deps         optional injected seams for testing
 * @returns every matching review note, flattened in PR-number order
 */
export async function fetchPriorReviewNotes(
  client: Octokit,
  ref: RepoRef,
  issueNumber: number,
  deps: FetchPriorReviewNotesDeps = {},
): Promise<PriorReviewNote[]> {
  const listMerged =
    deps.listCrossReferencedMergedPRs ??
    buildDefaultListCrossReferencedMergedPRs(client);
  const listComments =
    deps.listPRComments ?? buildDefaultListPRComments(client);

  const prNumbers = await listMerged(ref, issueNumber);
  if (prNumbers.length === 0) return [];

  const regex = buildStandaloneReferenceRegex(issueNumber);

  // Fetch comments for each PR in parallel — independent reads, bounded by
  // the (small) number of merged PRs that cross-referenced this issue.
  const perPR = await Promise.all(
    prNumbers.map(async (prNumber) => {
      const comments = await listComments(ref, prNumber);
      return comments
        .filter((c) => regex.test(c.body))
        .map<PriorReviewNote>((c) => ({
          prNumber,
          commentUrl: c.url,
          author: c.author,
          body: c.body,
        }));
    }),
  );

  return perPR.flat();
}

/**
 * Default `listCrossReferencedMergedPRs` — walks the issue timeline, filters
 * to `cross-referenced` events whose source is a PR, then keeps only the ones
 * that actually merged.
 */
function buildDefaultListCrossReferencedMergedPRs(
  client: Octokit,
): (ref: RepoRef, issueNumber: number) => Promise<number[]> {
  return async (ref, issueNumber) => {
    const events = await client.paginate(
      client.issues.listEventsForTimeline,
      {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: issueNumber,
        per_page: 100,
      },
    );

    const sourcePRNumbers = new Set<number>();
    for (const event of events) {
      const prNumber = extractCrossReferencedPRNumber(event);
      if (prNumber !== null) sourcePRNumbers.add(prNumber);
    }

    if (sourcePRNumbers.size === 0) return [];

    // Deduplicated so we never hit the PR endpoint twice for the same source.
    const merged: number[] = [];
    await Promise.all(
      Array.from(sourcePRNumbers).map(async (prNumber) => {
        const isMerged = await isPRMerged(client, ref, prNumber);
        if (isMerged) merged.push(prNumber);
      }),
    );
    return merged.sort((a, b) => a - b);
  };
}

/**
 * Default `listPRComments` — pulls every top-level issue comment on a PR
 * (where review agents post their verdicts).
 */
function buildDefaultListPRComments(
  client: Octokit,
): (ref: RepoRef, prNumber: number) => Promise<RawComment[]> {
  return async (ref, prNumber) => {
    const rows = await client.paginate(client.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    return rows.map((row) => ({
      body: row.body ?? "",
      author: row.user?.login ?? "unknown",
      url: row.html_url,
    }));
  };
}

/**
 * Extract the source PR number from a `cross-referenced` timeline event, or
 * `null` when the event does not point at a PR.
 *
 * The timeline endpoint returns both issue-to-issue and issue-to-PR cross
 * references; we only want the latter because only PRs can carry review
 * comments worth reading.
 */
export function extractCrossReferencedPRNumber(event: unknown): number | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  if (record["event"] !== "cross-referenced") return null;

  const source = record["source"];
  if (typeof source !== "object" || source === null) return null;
  const issue = (source as Record<string, unknown>)["issue"];
  if (typeof issue !== "object" || issue === null) return null;

  const issueRecord = issue as Record<string, unknown>;
  // `source.issue` is only a PR when the `pull_request` field is present.
  if (issueRecord["pull_request"] === undefined) return null;

  const number = issueRecord["number"];
  return typeof number === "number" ? number : null;
}

/**
 * Check whether a PR has been merged. Returns `false` for closed-unmerged and
 * open PRs alike — the caller only cares about the merged path.
 */
async function isPRMerged(
  client: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<boolean> {
  const { data } = await client.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: prNumber,
  });
  return data.merged_at !== null && data.merged_at !== undefined;
}
