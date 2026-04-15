/**
 * The repo state inspector — v0.1's first-failure-halts gate.
 *
 * {@link inspectRepo} runs 13 ordered checks against a pre-loaded milestone
 * and returns on the first failure (or all-clear). There is no self-healing,
 * no AI recovery, and no mutation. Every failure comes back as a
 * {@link CheckResult} carrying a {@link ClawError} the CLI can render with
 * the standard `[CLAW] Stopped — …` format.
 *
 * AI-driven recovery is a v0.5 concern — see ROADMAP.md.
 */
import type { Octokit } from "@octokit/rest";
import type { Milestone } from "../roadmap/parser.js";
import { parseRepoString } from "../github/repo-detect.js";
import { check01Roadmap } from "./check-01-roadmap.js";
import { check02Milestone } from "./check-02-milestone.js";
import { check03IssuesExist } from "./check-03-issues-exist.js";
import { check04AllIssuesClosed } from "./check-04-all-issues-closed.js";
import { check05CurrentNeedsHuman } from "./check-05-current-needs-human.js";
import { check06MultipleClawBranches } from "./check-06-multiple-claw-branches.js";
import { check07PrNoLinkedIssue } from "./check-07-pr-no-linked-issue.js";
import { check08BranchNoPr } from "./check-08-branch-no-pr.js";
import { check09BranchBehind } from "./check-09-branch-behind.js";
import { check10MissingReviews } from "./check-10-missing-reviews.js";
import { check11Blocked3Attempts } from "./check-11-blocked-3-attempts.js";
import { check12CiFailing } from "./check-12-ci-failing.js";
import { check13Unexpected } from "./check-13-unexpected.js";
import { buildRepoState } from "./state.js";
import type { BuildRepoStateDeps } from "./state.js";
import type { CheckResult, RepoState } from "./types.js";

export type { CheckResult, RepoState } from "./types.js";

/** Seams the inspector uses so tests can provide a pre-built {@link RepoState}. */
export interface InspectRepoDeps {
  /**
   * Override the state builder entirely. Tests pass a pre-built `RepoState`
   * so checks can be exercised without any GitHub or filesystem access.
   */
  buildState?: (
    client: Octokit,
    repo: string,
    milestone: Milestone,
  ) => Promise<RepoState>;
  /**
   * Working directory used by the default state builder to read
   * `.claw/sessions/`. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /** Seams forwarded to the default `buildRepoState` implementation. */
  state?: BuildRepoStateDeps;
}

/**
 * Run the 13 ordered checks against the target repo.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo the target repo in the form `owner/repo`
 * @param milestone the current milestone, already parsed via `parseRoadmap`
 * @param deps optional seams for tests
 * @returns the first failing check, or `{ passed: true }` when all pass
 * @throws {ClawError} when `repo` is malformed — everything else surfaces via the result
 */
export async function inspectRepo(
  client: Octokit,
  repo: string,
  milestone: Milestone,
  deps: InspectRepoDeps = {},
): Promise<CheckResult> {
  const ref = parseRepoString(repo);
  const state = deps.buildState
    ? await deps.buildState(client, repo, milestone)
    : await buildRepoState({
        client,
        ref,
        milestone,
        cwd: deps.cwd ?? process.cwd(),
        deps: deps.state,
      });

  return runChecks(state);
}

/**
 * Execute the 13 ordered checks against a pre-built state.
 *
 * Exported so tests can hand-roll a `RepoState` and drive the ordering logic
 * without any Octokit or filesystem fakes. Production callers go through
 * {@link inspectRepo}.
 */
export function runChecks(state: RepoState): CheckResult {
  const repoSlug = `${state.ref.owner}/${state.ref.repo}`;

  // Ordered, deterministic. Do NOT reorder without updating the roadmap
  // state-machine table in ROADMAP.md — the two must stay in sync.
  const steps: Array<() => CheckResult> = [
    () => check01Roadmap(true, repoSlug),
    () => check02Milestone(state.milestone.name),
    () => check03IssuesExist(state.milestone.name, state.milestone.issues),
    () => check04AllIssuesClosed(state.milestone.name, state.milestone.issues),
    () => check05CurrentNeedsHuman(state.milestone.issues),
    () => check06MultipleClawBranches(state.clawBranches),
    () => check07PrNoLinkedIssue(state.openPullRequests),
    () => check08BranchNoPr(state.clawBranches, state.openPullRequests),
    () => check09BranchBehind(state.defaultBranch, state.branchBehind),
    () => check10MissingReviews(state.openPullRequests),
    () => check11Blocked3Attempts(state.openPullRequests, state.sessions),
    () => check12CiFailing(state.openPullRequests),
    () =>
      check13Unexpected(
        state.milestone.issues,
        state.openPullRequests,
        state.sessions,
      ),
  ];

  for (const step of steps) {
    const result = step();
    if (!result.passed) return result;
  }
  return { passed: true };
}
