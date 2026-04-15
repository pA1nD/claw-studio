import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { parseRepoString } from "../github/repo-detect.js";
import type { RepoRef } from "../github/repo-detect.js";
import type { Issue } from "../roadmap/parser.js";
import type { BranchInfo, CheckResult, PullRequestInfo } from "./types.js";
import { check01Roadmap } from "./check-01-roadmap.js";
import type { Check01Deps } from "./check-01-roadmap.js";
import { check02Milestone } from "./check-02-milestone.js";
import { check03IssuesExist } from "./check-03-issues-exist.js";
import { check04MilestoneComplete } from "./check-04-milestone-complete.js";
import { check05NeedsHuman } from "./check-05-needs-human.js";
import { check06MultipleBranches } from "./check-06-multiple-branches.js";
import { check07PRNoIssue } from "./check-07-pr-no-issue.js";
import { check08BranchNoPR } from "./check-08-branch-no-pr.js";
import { check09BranchBehind } from "./check-09-branch-behind.js";
import type { Check09Deps } from "./check-09-branch-behind.js";
import { check10MissingReviews } from "./check-10-missing-reviews.js";
import type { Check10Deps } from "./check-10-missing-reviews.js";
import { check11MaxFixAttempts } from "./check-11-max-fix-attempts.js";
import type { Check11Deps } from "./check-11-max-fix-attempts.js";
import { check12CIFailing } from "./check-12-ci-failing.js";
import type { Check12Deps } from "./check-12-ci-failing.js";
import { check13Unexpected } from "./check-13-unexpected.js";

/**
 * Options accepted by {@link inspectRepo}.
 *
 * Every dependency is optional and defaulted to a real Octokit-backed
 * implementation. Tests inject only what they need to drive a specific check
 * to pass or fail.
 */
export interface InspectRepoOptions {
  /** Working directory used for reading session files in CHECK 11. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected dependencies for testing the network-touching checks. */
  deps?: InspectorDeps;
}

/** All injectable seams the inspector exposes. */
export interface InspectorDeps {
  /** CHECK 1 — read `ROADMAP.md` from the repo. */
  readRoadmap?: Check01Deps["readRoadmap"];
  /** CHECK 3 + 4 input — list every issue (open and closed) for a milestone label. */
  listIssuesForLabel?: (
    ref: RepoRef,
    label: string,
  ) => Promise<Issue[]>;
  /** Read the repo metadata to discover the default branch (used by CHECK 9). */
  readDefaultBranch?: (ref: RepoRef) => Promise<string>;
  /** List every branch in the repo (used by CHECKS 6, 8, 9). */
  listBranches?: (ref: RepoRef) => Promise<BranchInfo[]>;
  /** List every open PR in the repo (used by CHECKS 5, 7, 8, 10, 11, 12, 13). */
  listOpenPullRequests?: (ref: RepoRef) => Promise<PullRequestInfo[]>;
  /** Per-check seams — passed straight through. */
  compareBranchToDefault?: Check09Deps["compareBranchToDefault"];
  listPRCommentBodies?: Check10Deps["listPRCommentBodies"];
  readSession?: Check11Deps["readSession"];
  listFailingChecks?: Check12Deps["listFailingChecks"];
}

/**
 * Run all 13 repo state checks in order. The first failed check is returned
 * verbatim and no later checks run.
 *
 * The inspector is a pure status read — it never writes to GitHub, never
 * mutates the filesystem, and never spawns agents. Recovery is the loop's
 * job, not the inspector's.
 *
 * Order matters: every check assumes the earlier checks have passed. CHECK 4
 * for example assumes CHECK 3 has already proven that the milestone has
 * issues, otherwise the "all closed" condition would be vacuously true.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   the target repo in `owner/repo` form
 * @param options optional cwd + injected dependencies
 * @returns the first non-passing {@link CheckResult}, or `{ passed: true }`
 *          when every check passes
 */
export async function inspectRepo(
  client: Octokit,
  repo: string,
  options: InspectRepoOptions = {},
): Promise<CheckResult> {
  try {
    return await runChecks(client, repo, options);
  } catch (err) {
    if (isRateLimitError(err)) {
      return { passed: false, error: toRateLimitClawError(err) };
    }
    throw err;
  }
}

async function runChecks(
  client: Octokit,
  repo: string,
  options: InspectRepoOptions,
): Promise<CheckResult> {
  const ref = parseRepoString(repo);
  const cwd = options.cwd ?? process.cwd();
  const deps = options.deps ?? {};

  const result1 = await check01Roadmap(client, ref, {
    readRoadmap: deps.readRoadmap,
  });
  if (!result1.passed) return result1;

  const result2 = check02Milestone(result1.content);
  if (!result2.passed) return result2;

  const listIssues = deps.listIssuesForLabel ?? buildDefaultListIssues(client);
  const issues = (await listIssues(ref, result2.milestoneName))
    .slice()
    .sort((a, b) => a.number - b.number);
  const milestone = { name: result2.milestoneName, issues };

  const result3 = check03IssuesExist(milestone);
  if (!result3.passed) return result3;

  const result4 = check04MilestoneComplete(milestone);
  if (!result4.passed) return result4;

  // Branches, PRs, and the default-branch name are three independent fetches
  // all needed downstream. Running them in parallel costs one unused call
  // when checks 5-8 halt early, but saves two serial round-trips on every
  // healthy cycle — the common case.
  const listBranches = deps.listBranches ?? buildDefaultListBranches(client);
  const listOpenPRs =
    deps.listOpenPullRequests ?? buildDefaultListOpenPRs(client);
  const readDefaultBranch =
    deps.readDefaultBranch ?? buildDefaultReadDefaultBranch(client);
  const [branches, openPRs, defaultBranch] = await Promise.all([
    listBranches(ref),
    listOpenPRs(ref),
    readDefaultBranch(ref),
  ]);

  const result5 = check05NeedsHuman(milestone, openPRs);
  if (!result5.passed) return result5;

  const result6 = check06MultipleBranches(branches);
  if (!result6.passed) return result6;

  const result7 = check07PRNoIssue(openPRs);
  if (!result7.passed) return result7;

  const result8 = check08BranchNoPR(branches, openPRs);
  if (!result8.passed) return result8;

  const result9 = await check09BranchBehind(client, ref, defaultBranch, branches, {
    compareBranchToDefault: deps.compareBranchToDefault,
  });
  if (!result9.passed) return result9;

  const result10 = await check10MissingReviews(client, ref, openPRs, {
    listPRCommentBodies: deps.listPRCommentBodies,
  });
  if (!result10.passed) return result10;

  const result11 = await check11MaxFixAttempts(cwd, openPRs, {
    readSession: deps.readSession,
  });
  if (!result11.passed) return result11;

  const result12 = await check12CIFailing(client, ref, openPRs, {
    listFailingChecks: deps.listFailingChecks,
  });
  if (!result12.passed) return result12;

  const result13 = check13Unexpected(openPRs, milestone);
  if (!result13.passed) return result13;

  return { passed: true };
}

/**
 * Detect a GitHub rate-limit response.
 *
 * GitHub returns `429 Too Many Requests` for secondary rate limits and
 * `403 Forbidden` with `X-RateLimit-Remaining: 0` for the primary one —
 * we have to recognise both shapes so the loop halts cleanly instead of
 * crashing with an unformatted exception.
 */
function isRateLimitError(err: unknown): boolean {
  const status = readNumberProp(err, "status");
  if (status !== 403 && status !== 429) return false;
  if (status === 429) return true;
  const remaining = readResponseHeader(err, "x-ratelimit-remaining");
  return remaining !== undefined && Number(remaining) === 0;
}

/** Format a rate-limit error into the standard `[CLAW] Stopped` shape. */
function toRateLimitClawError(err: unknown): ClawError {
  const resetSeconds = Number(readResponseHeader(err, "x-ratelimit-reset"));
  const hint = Number.isFinite(resetSeconds)
    ? `Limit resets at ${new Date(resetSeconds * 1000).toISOString()}. Run \`claw status\` to re-check once resolved.`
    : "Run `claw status` to re-check once resolved.";
  return new ClawError("GitHub API rate limit reached.", hint);
}

/** Read `err[key]` when it is a number, or `undefined`. */
function readNumberProp(err: unknown, key: string): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const val = (err as Record<string, unknown>)[key];
  return typeof val === "number" ? val : undefined;
}

/** Read `err.response.headers[key]` when it is a string, or `undefined`. */
function readResponseHeader(err: unknown, key: string): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const response = (err as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return undefined;
  const headers = (response as Record<string, unknown>).headers;
  if (typeof headers !== "object" || headers === null) return undefined;
  const val = (headers as Record<string, unknown>)[key];
  return typeof val === "string" ? val : undefined;
}

/**
 * Build the default Octokit-backed issue lister.
 *
 * Returns both open and closed issues — CHECK 4 relies on closed counts to
 * detect milestone completion. Filters out pull requests because the issues
 * endpoint returns both (GitHub stores PRs as issues internally).
 *
 * Logic mirrors `src/core/roadmap/parser.ts` deliberately — both modules
 * fetch labelled issues for downstream use, but their callers want different
 * shapes back (the inspector wants a flat list, the parser wants a Milestone
 * with the milestone name attached). The duplication is small enough that
 * extracting a shared helper would cost more in indirection than it saves.
 */
function buildDefaultListIssues(
  client: Octokit,
): (ref: RepoRef, label: string) => Promise<Issue[]> {
  return async (ref, label) => {
    const rows = await client.paginate(client.issues.listForRepo, {
      owner: ref.owner,
      repo: ref.repo,
      labels: label,
      state: "all",
      per_page: 100,
    });
    return rows
      .filter((row) => row.pull_request === undefined || row.pull_request === null)
      .map((row) => ({
        number: row.number,
        title: row.title,
        state: row.state === "closed" ? "closed" : "open",
        labels: (row.labels ?? [])
          .map((entry) =>
            typeof entry === "string" ? entry : entry?.name ?? null,
          )
          .filter((entry): entry is string => entry !== null && entry.length > 0),
        body: row.body ?? "",
      }));
  };
}

/** Build the default Octokit-backed branch lister. */
function buildDefaultListBranches(
  client: Octokit,
): (ref: RepoRef) => Promise<BranchInfo[]> {
  return async (ref) => {
    const rows = await client.paginate(client.repos.listBranches, {
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    return rows.map((row) => ({ name: row.name, sha: row.commit.sha }));
  };
}

/** Build the default Octokit-backed open-PR lister. */
function buildDefaultListOpenPRs(
  client: Octokit,
): (ref: RepoRef) => Promise<PullRequestInfo[]> {
  return async (ref) => {
    const rows = await client.paginate(client.pulls.list, {
      owner: ref.owner,
      repo: ref.repo,
      state: "open",
      per_page: 100,
    });
    return rows.map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      headRef: row.head.ref,
      baseRef: row.base.ref,
      headSha: row.head.sha,
    }));
  };
}

/**
 * Build the default Octokit-backed default-branch reader.
 *
 * Throws ClawError because an empty repo is a setup-time problem, not a
 * runtime one — the loop cannot meaningfully recover from it.
 */
function buildDefaultReadDefaultBranch(
  client: Octokit,
): (ref: RepoRef) => Promise<string> {
  return async (ref) => {
    const { data } = await client.repos.get({ owner: ref.owner, repo: ref.repo });
    if (typeof data.default_branch !== "string" || data.default_branch.length === 0) {
      throw new ClawError(
        `no default branch reported for ${ref.owner}/${ref.repo}.`,
        "Create an initial commit on the repo before running the loop.",
      );
    }
    return data.default_branch;
  };
}
