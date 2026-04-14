import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";

/**
 * Status check contexts that GitHub must see before allowing a merge.
 *
 * These names match the `name:` field of the matching jobs in the canonical
 * `ci.yml` template. Mismatched names silently disable protection, so the
 * constant is kept in lockstep with the template.
 */
export const REQUIRED_STATUS_CHECKS: readonly string[] = [
  "Lint",
  "Type Check",
  "Tests",
  "Review Summary",
];

/** Options for {@link configureBranchProtection}. */
export interface ConfigureBranchProtectionOptions {
  /** Target repository. */
  ref: RepoRef;
  /** Authenticated Octokit instance (must come from `createClient()`). */
  octokit: Pick<Octokit, "repos">;
  /**
   * Optional override for the default branch. When omitted, it is read
   * from the repo metadata — the common case.
   */
  branch?: string;
}

/**
 * Configure branch protection on the default branch of `ref`.
 *
 * Mirrors the rules in issue #18:
 *   - Require a PR before merging
 *   - Required status checks: `Lint`, `Type Check`, `Tests`, `Review Summary`
 *   - Enforce admins (so humans can't bypass either)
 *   - No force pushes, no direct pushes
 *
 * The status checks are set with `strict: true` so PRs must be up-to-date
 * with the branch before merging — this keeps the loop's mid-flight rebase
 * rule (see v0.1 git strategy) well-defined.
 *
 * @throws {ClawError} when the default branch cannot be read or the API call fails
 */
export async function configureBranchProtection(
  options: ConfigureBranchProtectionOptions,
): Promise<void> {
  const { ref, octokit } = options;
  const branch = options.branch ?? (await readDefaultBranch(ref, octokit));

  try {
    await octokit.repos.updateBranchProtection({
      owner: ref.owner,
      repo: ref.repo,
      branch,
      required_status_checks: {
        strict: true,
        contexts: [...REQUIRED_STATUS_CHECKS],
      },
      enforce_admins: true,
      required_pull_request_reviews: null,
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not set branch protection on ${branch}.`,
      `Check that your PAT has admin access to ${ref.owner}/${ref.repo}. Underlying error: ${detail}`,
    );
  }
}

/** Read `default_branch` from the repo metadata. */
async function readDefaultBranch(
  ref: RepoRef,
  octokit: Pick<Octokit, "repos">,
): Promise<string> {
  try {
    const { data } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    const branch = data.default_branch;
    if (typeof branch !== "string" || branch.length === 0) {
      throw new ClawError(
        `no default branch reported for ${ref.owner}/${ref.repo}.`,
        "Create an initial commit on the repo before running setup.",
      );
    }
    return branch;
  } catch (err: unknown) {
    if (err instanceof ClawError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not read repo metadata for ${ref.owner}/${ref.repo}.`,
      `Check that your PAT has repo scope. Underlying error: ${detail}`,
    );
  }
}
