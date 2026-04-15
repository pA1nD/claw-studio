import type { Octokit } from "@octokit/rest";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import { withRateLimitHandling } from "../github/rate-limit.js";
import { REVIEW_AGENT_HEADERS } from "../checks/types.js";

/**
 * The four verdicts the orchestrator uses to decide what to do with an open
 * PR on the current cycle.
 *
 *   - `pending`           — keep polling; reviews or CI are still running.
 *   - `approved`          — every agent approved, CI green, mergeable.
 *   - `changes-requested` — the Review Summary flagged blocking issues.
 *   - `ci-failing`        — one of the CI jobs is in a failing conclusion.
 */
export type PRVerdict =
  | "pending"
  | "approved"
  | "changes-requested"
  | "ci-failing";

/**
 * Header the summary job in `ci.yml` posts once it has read every agent's
 * verdict. The monitor looks for this marker to know the pipeline has finished.
 *
 * Kept in lockstep with the summary job's prompt in `src/core/templates/ci.yml`.
 */
export const REVIEW_SUMMARY_HEADER = "## Review Summary";

/**
 * Marker posted inside the Review Summary comment when every agent approved.
 *
 * Must match the string the summary job writes in `ci.yml` — the merge-gate
 * `Fail if changes requested` step greps for exactly this string, so the
 * monitor's contract is aligned with branch protection's contract.
 */
export const READY_TO_MERGE_MARKER = "### Ready to merge";

/**
 * Marker posted inside the Review Summary comment when at least one agent
 * requested changes.
 */
export const BLOCKING_ISSUES_MARKER = "### Blocking Issues";

/**
 * Check-run conclusions that count as "CI is failing".
 *
 * Mirrors `check-12-ci-failing.ts` deliberately. Pending runs (conclusion
 * `null`) are explicitly NOT failures here — a still-running CI surfaces as
 * `pending` via the mergeable-state gate further down.
 */
const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
]);

/**
 * The minimal PR metadata the monitor depends on. Kept narrower than
 * Octokit's `pulls.get` response so tests don't have to construct the full
 * payload.
 */
export interface PRMetadata {
  /** Tip commit SHA of the head branch — used to fetch CI runs for the PR. */
  headSha: string;
  /**
   * GitHub's `mergeable_state` field. `"clean"` is the only state the
   * monitor treats as "merge is actually safe" — every other state
   * (`"blocked"`, `"behind"`, `"dirty"`, `"unstable"`, `"unknown"`, `"draft"`)
   * surfaces as `pending` so the orchestrator never attempts a merge while
   * GitHub is still computing the answer.
   */
  mergeableState: string;
}

/**
 * One CI run as surfaced by the GitHub check-runs API. Only the fields the
 * monitor consumes are surfaced.
 */
export interface CIRun {
  /** Human-readable check name (e.g. `"Lint"`, `"Type Check"`, `"Tests"`). */
  name: string;
  /**
   * Final conclusion when the run has completed, or `null` when the run is
   * still in progress. The monitor treats `null` as "not failing" so a run
   * in progress doesn't short-circuit to `ci-failing` — still-running CI is
   * the `pending` case, which is handled by the mergeable-state gate.
   */
  conclusion: string | null;
}

/** Dependencies injected into {@link getPRVerdict}. */
export interface PRMonitorDeps {
  /**
   * Read the PR metadata used to drive the verdict. Default implementation
   * calls `pulls.get` and surfaces `head.sha` + `mergeable_state`.
   */
  readPRMetadata?: (ref: RepoRef, prNumber: number) => Promise<PRMetadata>;
  /**
   * Return every top-level PR comment body. The default paginates
   * `issues.listComments` — the GitHub endpoint that serves review-agent
   * comments — so a long discussion thread never silently truncates.
   */
  listPRCommentBodies?: (
    ref: RepoRef,
    prNumber: number,
  ) => Promise<string[]>;
  /**
   * Return every CI run (not just failing ones) for the PR's head SHA. The
   * default paginates `checks.listForRef`, the same endpoint CHECK 12 uses.
   */
  listCIRuns?: (ref: RepoRef, headSha: string) => Promise<CIRun[]>;
}

/**
 * Read the current verdict for an open PR.
 *
 * This is a pure read operation — no side effects, no mutations, no merges,
 * no comments. The monitor bridges the gap between "the PR is open" and
 * "the orchestrator needs to know what to do next": it reads CI state, the
 * five review-agent comment headers, and the Review Summary verdict, and
 * returns a single {@link PRVerdict}.
 *
 * Ordering of the verdict decisions matters:
 *
 *   1. **CI failing wins over everything.** A failing CI halts the loop via
 *      CHECK 12 — no point consulting reviews on a broken build.
 *   2. **All five agents must have posted** before the pipeline is
 *      considered ready. Partial sets are `pending` — CHECK 10 handles the
 *      stale "only some agents posted" case.
 *   3. **The Review Summary must be posted** before any verdict can fire.
 *      Until the summary lands the loop stays `pending`.
 *   4. **Blocking first, ready second.** If both markers appear in a single
 *      summary (shouldn't happen, but defensive), blocking wins — the
 *      orchestrator should never merge a PR where an agent objected.
 *   5. **`mergeable_state === "clean"` is required** for `approved`.
 *      GitHub's mergeable computation is async; until it reports `clean`
 *      the loop waits to avoid racing the merge-gate.
 *
 * @param client    an Octokit client produced by `createClient()`
 * @param repo      target repository in `owner/repo` form
 * @param prNumber  the PR whose verdict should be read
 * @param deps      optional injected seams for testing
 * @returns the current {@link PRVerdict}
 * @throws {ClawError} when the GitHub API rate limit is exhausted
 */
export async function getPRVerdict(
  client: Octokit,
  repo: string,
  prNumber: number,
  deps: PRMonitorDeps = {},
): Promise<PRVerdict> {
  const ref = parseRepoString(repo);
  const readPR = deps.readPRMetadata ?? buildDefaultReadPRMetadata(client);
  const listBodies =
    deps.listPRCommentBodies ?? buildDefaultListCommentBodies(client);
  const listCI = deps.listCIRuns ?? buildDefaultListCIRuns(client);

  return withRateLimitHandling(async () => {
    // PR metadata is needed up front so CI can be looked up by head SHA —
    // looking up by head ref would miss stale runs from a previous push.
    const prMeta = await readPR(ref, prNumber);

    // Comments + CI runs are independent reads — fan them out so a slow
    // comments page never serialises behind a slow check-runs page.
    const [commentBodies, ciRuns] = await Promise.all([
      listBodies(ref, prNumber),
      listCI(ref, prMeta.headSha),
    ]);

    // 1. CI failing — halt quickly.
    if (hasFailingRun(ciRuns)) return "ci-failing";

    // 2. All five review agents must have posted.
    if (!allReviewsPosted(commentBodies)) return "pending";

    // 3. The summary must be posted (and we always read the latest one).
    const summaryBody = latestReviewSummary(commentBodies);
    if (summaryBody === null) return "pending";

    // 4. Blocking markers override anything else. Fix cycle.
    if (summaryBody.includes(BLOCKING_ISSUES_MARKER)) {
      return "changes-requested";
    }

    // 5. Anything short of "ready to merge" stays pending.
    if (!summaryBody.includes(READY_TO_MERGE_MARKER)) return "pending";

    // 6. Wait for GitHub to finish computing mergeability before we act.
    if (prMeta.mergeableState !== "clean") return "pending";

    return "approved";
  });
}

/**
 * True when any CI run has a conclusion from {@link FAILING_CONCLUSIONS}.
 *
 * Null/undefined conclusions (still-running checks) are intentionally NOT
 * failures — pending CI is the `pending` verdict, not `ci-failing`.
 */
export function hasFailingRun(runs: readonly CIRun[]): boolean {
  for (const run of runs) {
    if (typeof run.conclusion !== "string") continue;
    if (FAILING_CONCLUSIONS.has(run.conclusion)) return true;
  }
  return false;
}

/**
 * True when every {@link REVIEW_AGENT_HEADERS} entry appears at the start of
 * at least one comment body (leading whitespace tolerated, mirroring CHECK
 * 10's matcher).
 */
export function allReviewsPosted(commentBodies: readonly string[]): boolean {
  for (const header of REVIEW_AGENT_HEADERS) {
    const found = commentBodies.some((body) =>
      body.trimStart().startsWith(header),
    );
    if (!found) return false;
  }
  return true;
}

/**
 * Return the body of the **latest** `## Review Summary` comment, or `null`
 * when none has been posted.
 *
 * Fix cycles trigger a fresh run of the summary job, so earlier summaries
 * reflect stale rounds — the `Fail if changes requested` step in `ci.yml`
 * reads the latest summary by design, and this helper must match that
 * contract so the monitor and the merge gate agree on what verdict is live.
 *
 * @param commentBodies comments in the order GitHub returned them (chronological)
 */
export function latestReviewSummary(
  commentBodies: readonly string[],
): string | null {
  for (let i = commentBodies.length - 1; i >= 0; i -= 1) {
    const body = commentBodies[i];
    if (body === undefined) continue;
    if (body.trimStart().startsWith(REVIEW_SUMMARY_HEADER)) return body;
  }
  return null;
}

/**
 * Build the default PR metadata reader. Extracts `head.sha` and
 * `mergeable_state` from `pulls.get`.
 *
 * GitHub computes `mergeable_state` asynchronously. When the field is not
 * yet known it reports `"unknown"` — the monitor treats that as `pending`
 * (the mergeable gate won't match `"clean"`), so there's no retry loop here.
 * A subsequent cycle will pick up the updated state.
 */
function buildDefaultReadPRMetadata(
  client: Octokit,
): (ref: RepoRef, prNumber: number) => Promise<PRMetadata> {
  return async (ref, prNumber) => {
    const { data } = await client.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
    });
    return {
      headSha: data.head.sha,
      mergeableState:
        typeof data.mergeable_state === "string" ? data.mergeable_state : "",
    };
  };
}

/**
 * Build the default PR-comment lister. Mirrors `check-10-missing-reviews` —
 * review-agent comments land on the issue-comments endpoint (which also
 * serves PR conversations).
 */
function buildDefaultListCommentBodies(
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

/**
 * Build the default CI run lister. Paginates `checks.listForRef` — the
 * modern check-runs API — so `ci.yml`'s Actions-reported jobs are visible.
 */
function buildDefaultListCIRuns(
  client: Octokit,
): (ref: RepoRef, headSha: string) => Promise<CIRun[]> {
  return async (ref, headSha) => {
    const runs = await client.paginate(client.checks.listForRef, {
      owner: ref.owner,
      repo: ref.repo,
      ref: headSha,
      per_page: 100,
    });
    return runs.map((run) => ({
      name: run.name,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    }));
  };
}
