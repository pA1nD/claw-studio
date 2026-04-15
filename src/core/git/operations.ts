import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import { withRateLimitHandling } from "../github/rate-limit.js";
import { CLAW_BRANCH_PREFIX, isClawBranch } from "../checks/types.js";
import { branchName } from "./branch-name.js";

/**
 * Re-export of the canonical branch-name helper (defined in
 * `./branch-name.ts`, this module's sibling).
 *
 * CLAUDE.md designates `src/core/git/` as the single home for git concerns, so
 * the git operations module is the public entry point callers import from.
 * The `core/agents/branch-name.ts` module re-exports from `core/git/` for
 * backwards compatibility with the implementation agent (issue #3) that
 * originally seeded the helper — the dependency direction now flows the
 * correct way (agents → git), not the inverse.
 */
export { branchName };

/**
 * Error thrown when a rebase or merge cannot complete because the default
 * branch has diverged irreconcilably from the target.
 *
 * Subclass of {@link ClawError} so it travels through the standard error
 * rendering path (`[CLAW] Stopped — …`) without requiring a special case in
 * the CLI, while still carrying enough detail for the orchestrator (issue #7)
 * to route it to the implementation agent's fix cycle rather than halting.
 */
export class GitConflictError extends ClawError {
  /** Whether the conflict surfaced from a rebase or a merge attempt. */
  public readonly operation: "rebase" | "merge";
  /** The `claw/`-prefixed branch that could not be updated. */
  public readonly branch: string;

  /**
   * Create a GitConflictError.
   *
   * @param operation which git operation hit the conflict
   * @param branch    the branch that could not be updated
   */
  constructor(operation: "rebase" | "merge", branch: string) {
    super(
      `${operation} hit conflicts on ${branch}.`,
      "Resume the implementation agent in the same session to resolve, or label the linked issue `needs-human` if auto-resolution fails.",
    );
    this.name = "GitConflictError";
    this.operation = operation;
    this.branch = branch;
  }
}

/**
 * Type guard for {@link GitConflictError}. Use from the orchestrator to route a
 * conflict to the fix cycle rather than halting on the generic `ClawError`
 * path.
 *
 * @param value value to test
 * @returns true if `value` is an instance of GitConflictError
 */
export function isGitConflictError(value: unknown): value is GitConflictError {
  return value instanceof GitConflictError;
}

/** Dependencies injected into {@link createBranch}. */
export interface CreateBranchDeps {
  /**
   * Read the default branch's name and tip commit SHA. Defaults to
   * `repos.get` + `git.getRef`.
   */
  readDefaultBranchHead?: (
    ref: RepoRef,
  ) => Promise<{ name: string; sha: string }>;
  /**
   * Create a git ref on the target repo. Defaults to `git.createRef`.
   */
  createRef?: (ref: RepoRef, fullRef: string, sha: string) => Promise<void>;
}

/** Dependencies injected into {@link rebaseOnDefault}. */
export interface RebaseOnDefaultDeps {
  /**
   * Find the open PR number whose head matches `branch`, or `null` when no
   * open PR exists. Defaults to paginating `pulls.list` with a head filter.
   */
  findOpenPullNumberForBranch?: (
    ref: RepoRef,
    branch: string,
  ) => Promise<number | null>;
  /**
   * Invoke GitHub's "Update pull request branch" endpoint, which merges the
   * latest default branch into the PR head. Defaults to `pulls.updateBranch`.
   */
  updatePullRequestBranch?: (ref: RepoRef, prNumber: number) => Promise<void>;
}

/** Dependencies injected into {@link mergeDefaultIntoBranch}. */
export interface MergeDefaultIntoBranchDeps {
  /**
   * Read the name of the default branch. Defaults to `repos.get`.
   */
  readDefaultBranchName?: (ref: RepoRef) => Promise<string>;
  /**
   * Merge `head` into `base` on the server. Defaults to `repos.merge`.
   *
   * Resolves successfully on both `201 Created` (merge commit created) and
   * `204 No Content` (branch was already up to date) — the orchestrator
   * treats both as "branch now contains default", so the distinction is not
   * surfaced to callers. Conflicts throw and are caught upstream.
   */
  mergeRefs?: (ref: RepoRef, base: string, head: string) => Promise<void>;
}

/** Dependencies injected into {@link squashMerge}. */
export interface SquashMergeDeps {
  /**
   * Squash-merge a pull request. Defaults to `pulls.merge` with
   * `merge_method: "squash"`.
   */
  mergePullRequest?: (
    ref: RepoRef,
    prNumber: number,
    commitTitle: string,
    commitMessage: string,
  ) => Promise<{ sha: string }>;
}

/** Dependencies injected into {@link deleteBranch}. */
export interface DeleteBranchDeps {
  /**
   * Delete a git ref. Defaults to `git.deleteRef`.
   *
   * `shortRef` is the ref **without** the `refs/` prefix — GitHub's
   * `git.deleteRef` accepts `heads/{branch}` (not `refs/heads/{branch}`),
   * which is the opposite convention from `git.createRef` (see
   * {@link CreateBranchDeps.createRef}). Passing `refs/heads/{branch}` here
   * would surface as a silent 422 from GitHub, so the parameter name mirrors
   * the API contract rather than the `createRef` seam's shape.
   */
  deleteRef?: (ref: RepoRef, shortRef: string) => Promise<void>;
}

/**
 * Create a new branch from the latest commit on the default branch.
 *
 * The branch MUST be `claw/`-prefixed. Any other shape is rejected with a
 * {@link ClawError} so the loop cannot accidentally touch a human branch
 * (see CLAUDE.md "Git rules").
 *
 * Implementation note: reads the default branch name and its tip SHA via two
 * GitHub API calls, then creates a ref at `refs/heads/{branch}` pointing at
 * the tip. `git.createRef` is the only API that can create a branch without
 * requiring a pre-existing commit to push from.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   target repository in `owner/repo` form
 * @param branch the branch to create (must start with `claw/`)
 * @param deps   optional injected seams for testing
 * @throws {ClawError} when `branch` is not `claw/`-prefixed, when the repo has
 *                    no default branch, or on a GitHub rate-limit response
 */
export async function createBranch(
  client: Octokit,
  repo: string,
  branch: string,
  deps: CreateBranchDeps = {},
): Promise<void> {
  assertClawBranch(branch);
  const ref = parseRepoString(repo);
  const readHead = deps.readDefaultBranchHead ?? buildReadDefaultBranchHead(client);
  const createRef = deps.createRef ?? buildCreateRef(client);

  await withRateLimitHandling(async () => {
    const { sha } = await readHead(ref);
    await createRef(ref, `refs/heads/${branch}`, sha);
  });
}

/**
 * Update `branch` to include the latest default branch changes via GitHub's
 * "Update pull request branch" endpoint.
 *
 * Call this when the branch is behind the default AND the PR has no open
 * review comments — rebasing on a commented PR would destroy the comment
 * thread anchors, so {@link mergeDefaultIntoBranch} is the right choice in
 * that case.
 *
 * v0.1 caveat: the `pulls.updateBranch` endpoint performs a merge on GitHub's
 * side, not a true rebase — the server produces a merge commit rather than a
 * linear history. True rebase with clean history requires local git with a
 * `--force-with-lease` push, which is a post-v0.1 refinement because the
 * orchestrator does not yet own a local working copy. For v0.1, the net
 * semantic outcome (branch includes latest default, CI reruns, mergeable
 * status recomputed) is correct.
 *
 * A conflict surfaces as {@link GitConflictError} so the orchestrator can
 * route it to the fix cycle rather than halting the loop.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   target repository in `owner/repo` form
 * @param branch the branch to update (must start with `claw/`)
 * @param deps   optional injected seams for testing
 * @throws {GitConflictError} on a conflict with the default branch
 * @throws {ClawError}        when `branch` is not `claw/`-prefixed, when no
 *                            open PR exists for the branch, or on a GitHub
 *                            rate-limit response
 */
export async function rebaseOnDefault(
  client: Octokit,
  repo: string,
  branch: string,
  deps: RebaseOnDefaultDeps = {},
): Promise<void> {
  assertClawBranch(branch);
  const ref = parseRepoString(repo);
  const findPr =
    deps.findOpenPullNumberForBranch ??
    buildFindOpenPullNumberForBranch(client);
  const updateBranch =
    deps.updatePullRequestBranch ?? buildUpdatePullRequestBranch(client);

  await withRateLimitHandling(async () => {
    const prNumber = await findPr(ref, branch);
    if (prNumber === null) {
      throw new ClawError(
        `no open PR found for branch ${branch}.`,
        "Open a pull request for this branch before the loop resumes — or run `claw status` to let the inspector diagnose the correct next step.",
      );
    }
    try {
      await updateBranch(ref, prNumber);
    } catch (err) {
      if (isMergeConflictError(err)) {
        throw new GitConflictError("rebase", branch);
      }
      throw err;
    }
  });
}

/**
 * Merge the default branch into `branch` via GitHub's direct branch-to-branch
 * merge API.
 *
 * Call this when the branch is behind the default AND the PR has open review
 * comments — the resulting merge commit catches the branch up without
 * rewriting history, so every existing review comment remains anchored to
 * its original commit. The server returns `204 No Content` when the branch
 * is already up to date; this is treated as success with no commit created.
 *
 * A conflict surfaces as {@link GitConflictError} so the orchestrator can
 * route it to the fix cycle rather than halting the loop.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   target repository in `owner/repo` form
 * @param branch the branch to update (must start with `claw/`)
 * @param deps   optional injected seams for testing
 * @throws {GitConflictError} on a merge conflict with the default branch
 * @throws {ClawError}        when `branch` is not `claw/`-prefixed, when the
 *                            repo has no default branch, or on a GitHub
 *                            rate-limit response
 */
export async function mergeDefaultIntoBranch(
  client: Octokit,
  repo: string,
  branch: string,
  deps: MergeDefaultIntoBranchDeps = {},
): Promise<void> {
  assertClawBranch(branch);
  const ref = parseRepoString(repo);
  const readDefault =
    deps.readDefaultBranchName ?? buildReadDefaultBranchName(client);
  const mergeRefs = deps.mergeRefs ?? buildMergeRefs(client);

  await withRateLimitHandling(async () => {
    const defaultBranch = await readDefault(ref);
    try {
      await mergeRefs(ref, branch, defaultBranch);
    } catch (err) {
      if (isMergeConflictError(err)) {
        throw new GitConflictError("merge", branch);
      }
      throw err;
    }
  });
}

/**
 * Squash-merge a pull request into the default branch.
 *
 * Commit message format is fixed per CLAUDE.md: one commit per issue, message
 * `feat: {issue title} (closes #{N})`. The `closes #{N}` suffix is what
 * GitHub uses to auto-close the linked issue on merge, so it MUST appear
 * verbatim in the commit title.
 *
 * @param client      an Octokit client produced by `createClient()`
 * @param repo        target repository in `owner/repo` form
 * @param prNumber    the pull request to merge
 * @param issueTitle  the linked issue's title (becomes the commit title body)
 * @param issueNumber the linked issue number (becomes the `closes #{N}` token)
 * @param deps        optional injected seams for testing
 * @returns the SHA of the new commit on the default branch
 * @throws {ClawError} on a GitHub rate-limit response or when the merge fails
 */
export async function squashMerge(
  client: Octokit,
  repo: string,
  prNumber: number,
  issueTitle: string,
  issueNumber: number,
  deps: SquashMergeDeps = {},
): Promise<{ sha: string }> {
  const ref = parseRepoString(repo);
  const mergePR = deps.mergePullRequest ?? buildMergePullRequest(client);
  const title = buildSquashCommitTitle(issueTitle, issueNumber);
  const message = buildSquashCommitMessage(issueNumber);

  return await withRateLimitHandling(async () => {
    return await mergePR(ref, prNumber, title, message);
  });
}

/**
 * Delete a branch.
 *
 * Safety-gated on the `claw/` prefix so the loop can never delete a human
 * branch, even if an upstream caller passes the wrong argument. Callers are
 * responsible for ordering: per CLAUDE.md, a branch is only deleted after
 * its PR is merged.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   target repository in `owner/repo` form
 * @param branch the branch to delete (must start with `claw/`)
 * @param deps   optional injected seams for testing
 * @throws {ClawError} when `branch` is not `claw/`-prefixed or on a GitHub
 *                    rate-limit response
 */
export async function deleteBranch(
  client: Octokit,
  repo: string,
  branch: string,
  deps: DeleteBranchDeps = {},
): Promise<void> {
  assertClawBranch(branch);
  const ref = parseRepoString(repo);
  const deleteRef = deps.deleteRef ?? buildDeleteRef(client);

  await withRateLimitHandling(async () => {
    await deleteRef(ref, `heads/${branch}`);
  });
}

/**
 * Build the squash commit title.
 *
 * Format: `feat: {issueTitle} (closes #{issueNumber})`. This exact string ends
 * up on the default branch's history and is what GitHub parses to auto-close
 * the issue — changing it without updating CLAUDE.md and the implementation
 * agent's PR body breaks the auto-close contract.
 *
 * @param issueTitle  the linked issue title (trimmed; whitespace preserved)
 * @param issueNumber the linked issue number
 * @returns the squash commit title string
 */
export function buildSquashCommitTitle(
  issueTitle: string,
  issueNumber: number,
): string {
  return `feat: ${issueTitle.trim()} (closes #${issueNumber})`;
}

/**
 * Build the squash commit body.
 *
 * Mirrors the `Closes #{N}` token the implementation agent writes into the PR
 * body (see `core/agents/implementation.ts:buildPullRequestBody`) so the
 * default branch history carries the same audit-trail link the PR did.
 *
 * @param issueNumber the linked issue number
 * @returns the squash commit body string
 */
export function buildSquashCommitMessage(issueNumber: number): string {
  return `Closes #${issueNumber}\n`;
}

/**
 * True when an error from the GitHub API represents a merge conflict.
 *
 * `repos.merge` returns `409 Conflict` on a merge conflict.
 * `pulls.updateBranch` can return `422 Unprocessable Entity` with a body
 *   containing the word "conflict" when the branch cannot be advanced.
 *
 * Non-object values and other statuses (including `404 Not Found`, `403
 * Forbidden` without the rate-limit header, etc.) return false — each caller
 * handles those via the generic `ClawError` path.
 *
 * @param err an unknown error from a GitHub API call
 * @returns true when the error represents a merge conflict
 */
export function isMergeConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  const status = record["status"];
  if (status === 409) return true;
  if (status === 422) {
    const message = record["message"];
    if (typeof message === "string" && /conflict/i.test(message)) return true;
  }
  return false;
}

/**
 * Throw when `branch` is not a claw-owned branch. Every public operation in
 * this module guards on this so a wrong argument from a future caller cannot
 * cause the loop to touch a human branch.
 */
function assertClawBranch(branch: string): void {
  if (!isClawBranch(branch)) {
    throw new ClawError(
      `refusing to operate on non-claw branch ${branch}.`,
      `Claw Studio only touches branches prefixed \`${CLAW_BRANCH_PREFIX}\` — see CLAUDE.md "Git rules".`,
    );
  }
}

/** Build the default `readDefaultBranchHead` seam (reads repo + head ref). */
function buildReadDefaultBranchHead(
  client: Octokit,
): (ref: RepoRef) => Promise<{ name: string; sha: string }> {
  return async (ref) => {
    const name = await readDefaultBranchNameFromApi(client, ref);
    const { data } = await client.git.getRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: `heads/${name}`,
    });
    return { name, sha: data.object.sha };
  };
}

/** Build the default `createRef` seam. */
function buildCreateRef(
  client: Octokit,
): (ref: RepoRef, fullRef: string, sha: string) => Promise<void> {
  return async (ref, fullRef, sha) => {
    await client.git.createRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: fullRef,
      sha,
    });
  };
}

/** Build the default `findOpenPullNumberForBranch` seam. */
function buildFindOpenPullNumberForBranch(
  client: Octokit,
): (ref: RepoRef, branch: string) => Promise<number | null> {
  return async (ref, branch) => {
    const rows = await client.paginate(client.pulls.list, {
      owner: ref.owner,
      repo: ref.repo,
      state: "open",
      // `head` filter expects `owner:branch` form — scoped to the target owner
      // so forks cannot shadow the PR lookup.
      head: `${ref.owner}:${branch}`,
      per_page: 100,
    });
    const first = rows[0];
    return first ? first.number : null;
  };
}

/** Build the default `updatePullRequestBranch` seam. */
function buildUpdatePullRequestBranch(
  client: Octokit,
): (ref: RepoRef, prNumber: number) => Promise<void> {
  return async (ref, prNumber) => {
    await client.pulls.updateBranch({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
    });
  };
}

/** Build the default `readDefaultBranchName` seam. */
function buildReadDefaultBranchName(
  client: Octokit,
): (ref: RepoRef) => Promise<string> {
  return async (ref) => readDefaultBranchNameFromApi(client, ref);
}

/** Build the default `mergeRefs` seam. */
function buildMergeRefs(
  client: Octokit,
): (ref: RepoRef, base: string, head: string) => Promise<void> {
  return async (ref, base, head) => {
    await client.repos.merge({
      owner: ref.owner,
      repo: ref.repo,
      base,
      head,
      commit_message: `Merge ${head} into ${base}`,
    });
    // Both 201 (merge commit) and 204 (already up to date) resolve here;
    // the promise is void because the orchestrator treats them identically.
  };
}

/** Build the default `mergePullRequest` seam (squash). */
function buildMergePullRequest(
  client: Octokit,
): (
  ref: RepoRef,
  prNumber: number,
  commitTitle: string,
  commitMessage: string,
) => Promise<{ sha: string }> {
  return async (ref, prNumber, commitTitle, commitMessage) => {
    const { data } = await client.pulls.merge({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: prNumber,
      merge_method: "squash",
      commit_title: commitTitle,
      commit_message: commitMessage,
    });
    return { sha: data.sha };
  };
}

/** Build the default `deleteRef` seam. */
function buildDeleteRef(
  client: Octokit,
): (ref: RepoRef, shortRef: string) => Promise<void> {
  return async (ref, shortRef) => {
    await client.git.deleteRef({
      owner: ref.owner,
      repo: ref.repo,
      ref: shortRef,
    });
  };
}

/**
 * Read the default branch name via `repos.get` and raise a typed
 * {@link ClawError} when GitHub reports no default branch (an empty repo, or
 * a permissions issue that returns a partial response).
 */
async function readDefaultBranchNameFromApi(
  client: Octokit,
  ref: RepoRef,
): Promise<string> {
  const { data } = await client.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  });
  if (typeof data.default_branch !== "string" || data.default_branch.length === 0) {
    throw new ClawError(
      `no default branch reported for ${ref.owner}/${ref.repo}.`,
      "Create an initial commit on the repo before running git operations.",
    );
  }
  return data.default_branch;
}
