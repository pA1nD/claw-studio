import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";
import { FAILING_CI_CONCLUSIONS, isClawPullRequest } from "./types.js";
import type { CheckResult, PullRequestInfo } from "./types.js";

/** A failing CI check on a PR — only the field we surface to the human. */
export interface FailingCheck {
  /** Human-readable check name (e.g. `"Lint"`, `"Type Check"`, `"Tests"`). */
  name: string;
}

/** Dependencies injected into CHECK 12. */
export interface Check12Deps {
  /**
   * Return every failing CI check for a head SHA. Empty array means "no
   * failures" (which includes pending — pending is the PR monitor's domain,
   * not the inspector's).
   */
  listFailingChecks?: (
    ref: RepoRef,
    headSha: string,
  ) => Promise<FailingCheck[]>;
}

/**
 * CHECK 12 — CI is not failing on any open `claw/` PR.
 *
 * If lint / typecheck / tests fail, the loop must not attempt to merge — the
 * branch-protection gate would refuse anyway. Better to halt explicitly with
 * the failing check names so the human can fix the underlying problem.
 *
 * Pending checks are explicitly NOT a failure here — that case belongs to the
 * PR monitor (issue #4) which polls the verdict over time.
 *
 * Looks up checks by `pr.headSha` (not by head ref) because GitHub's
 * check-runs API is keyed by SHA. Using the SHA ensures we never read stale
 * results from a previous force-push.
 *
 * @param client   an Octokit client produced by `createClient()`
 * @param ref      the target repository
 * @param openPRs  every open PR on the repo
 * @param deps     optional injected seam for testing
 * @returns {@link CheckResult} — fails on the first PR with failing checks
 */
export async function check12CIFailing(
  client: Octokit,
  ref: RepoRef,
  openPRs: readonly PullRequestInfo[],
  deps: Check12Deps = {},
): Promise<CheckResult> {
  const listFailing = deps.listFailingChecks ?? buildDefaultListFailing(client);

  for (const pr of openPRs) {
    if (!isClawPullRequest(pr)) continue;

    const failing = await listFailing(ref, pr.headSha);
    if (failing.length === 0) continue;

    const names = failing.map((check) => check.name).join(", ");
    return {
      passed: false,
      error: new ClawError(
        `CI is failing on PR #${pr.number}: ${names}.`,
        "Fix CI before the loop can merge.",
      ),
    };
  }
  return { passed: true };
}

/**
 * Build the default Octokit-backed failing-checks fetcher.
 *
 * Uses `checks.listForRef` because the modern check-runs API is what the
 * Claw Studio `ci.yml` writes to (via GitHub Actions). The legacy combined
 * status API would miss check-suite reports.
 *
 * The set of "failing" conclusions lives in `checks/types.ts` as
 * {@link FAILING_CI_CONCLUSIONS} so CHECK 12 and the PR monitor never drift
 * apart on what counts as red.
 *
 * `null` (still running) is intentionally NOT a failure — pending state
 * belongs to the PR monitor.
 */
function buildDefaultListFailing(
  client: Octokit,
): (ref: RepoRef, headSha: string) => Promise<FailingCheck[]> {
  return async (ref, headSha) => {
    const runs = await client.paginate(client.checks.listForRef, {
      owner: ref.owner,
      repo: ref.repo,
      ref: headSha,
      per_page: 100,
    });
    return runs
      .filter((run) =>
        typeof run.conclusion === "string" && FAILING_CI_CONCLUSIONS.has(run.conclusion),
      )
      .map((run) => ({ name: run.name }));
  };
}
