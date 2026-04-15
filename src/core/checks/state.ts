/**
 * Build the read-only {@link RepoState} the inspector passes to every check.
 *
 * Every GitHub API call used by any check is made here, once, up front. The
 * checks themselves are pure synchronous (or near-pure) functions against the
 * resulting state — that is what lets them be unit-tested without ever
 * building a fake Octokit.
 *
 * Every default implementation can be swapped via {@link BuildRepoStateDeps},
 * so tests drive the state builder with hand-rolled fixtures instead of
 * touching the real API or filesystem.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import type { Milestone } from "../roadmap/parser.js";
import type { RepoRef } from "../github/repo-detect.js";
import { resolveSetupPaths } from "../setup/paths.js";
import { REVIEW_AGENTS, extractLinkedIssue } from "./pr.js";
import type {
  PullRequestSummary,
  RepoState,
  ReviewVerdict,
  SessionRecord,
  StatusCheckSummary,
} from "./types.js";

/** Seams the state builder uses — each one defaults to a real implementation. */
export interface BuildRepoStateDeps {
  /** Return the default branch name for the repo. */
  getDefaultBranch?: (ref: RepoRef) => Promise<string>;
  /** Return every `claw/`-prefixed branch name on the remote. */
  listClawBranches?: (ref: RepoRef) => Promise<string[]>;
  /** Return every open PR whose head ref starts with `claw/`. */
  listOpenPullRequests?: (ref: RepoRef) => Promise<PullRequestSummary[]>;
  /** Return the number of commits `head` is behind `base`. */
  compareBranch?: (ref: RepoRef, base: string, head: string) => Promise<number>;
  /** Return session records keyed by issue number from `.claw/sessions/`. */
  readSessions?: (cwd: string) => Promise<Record<number, SessionRecord>>;
}

/** Options accepted by {@link buildRepoState}. */
export interface BuildRepoStateOptions {
  client: Octokit;
  ref: RepoRef;
  milestone: Milestone;
  /** Working directory — used to resolve `.claw/sessions/`. */
  cwd: string;
  deps?: BuildRepoStateDeps;
}

/**
 * Fetch every piece of data the 13 checks need, in parallel, and return it as
 * a read-only snapshot.
 */
export async function buildRepoState(
  options: BuildRepoStateOptions,
): Promise<RepoState> {
  const { client, ref, milestone, cwd } = options;
  const getDefaultBranch =
    options.deps?.getDefaultBranch ?? buildDefaultGetDefaultBranch(client);
  const listClawBranches =
    options.deps?.listClawBranches ?? buildDefaultListClawBranches(client);
  const listOpenPullRequests =
    options.deps?.listOpenPullRequests ?? buildDefaultListOpenPullRequests(client);
  const compareBranch =
    options.deps?.compareBranch ?? buildDefaultCompareBranch(client);
  const readSessions = options.deps?.readSessions ?? defaultReadSessions;

  // Independent lookups run in parallel to keep the overall latency low —
  // the loop calls this on every cycle, so every round-trip we save is
  // one less second between cycles.
  const [defaultBranch, clawBranches, openPullRequests, sessions] =
    await Promise.all([
      getDefaultBranch(ref),
      listClawBranches(ref),
      listOpenPullRequests(ref),
      readSessions(cwd),
    ]);

  // `compareBranch` depends on `defaultBranch` and the branch list so it
  // cannot be part of the parallel block above — but the individual calls
  // themselves are independent and can fan out.
  const behindEntries = await Promise.all(
    clawBranches.map(async (branch) => {
      const behind = await compareBranch(ref, defaultBranch, branch);
      return [branch, behind] as const;
    }),
  );
  const branchBehind: Record<string, number> = {};
  for (const [branch, behind] of behindEntries) {
    branchBehind[branch] = behind;
  }

  return {
    ref,
    milestone,
    defaultBranch,
    clawBranches,
    branchBehind,
    openPullRequests,
    sessions,
  };
}

/** Build the default `getDefaultBranch` implementation. */
function buildDefaultGetDefaultBranch(
  client: Octokit,
): (ref: RepoRef) => Promise<string> {
  return async (ref) => {
    const { data } = await client.repos.get({
      owner: ref.owner,
      repo: ref.repo,
    });
    return data.default_branch;
  };
}

/** Build the default `listClawBranches` implementation. */
function buildDefaultListClawBranches(
  client: Octokit,
): (ref: RepoRef) => Promise<string[]> {
  return async (ref) => {
    const rows = await client.paginate(client.repos.listBranches, {
      owner: ref.owner,
      repo: ref.repo,
      per_page: 100,
    });
    return rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string")
      .filter((name) => name.startsWith("claw/"))
      .sort();
  };
}

/** Build the default `listOpenPullRequests` implementation. */
function buildDefaultListOpenPullRequests(
  client: Octokit,
): (ref: RepoRef) => Promise<PullRequestSummary[]> {
  return async (ref) => {
    const prs = await client.paginate(client.pulls.list, {
      owner: ref.owner,
      repo: ref.repo,
      state: "open",
      per_page: 100,
    });
    const clawPrs = prs.filter((pr) => pr.head?.ref?.startsWith("claw/"));

    return Promise.all(
      clawPrs.map(async (pr) => {
        const body = pr.body ?? "";
        const [reviews, statusChecks] = await Promise.all([
          fetchReviews(client, ref, pr.number),
          fetchStatusChecks(client, ref, pr.head.sha),
        ]);
        return {
          number: pr.number,
          title: pr.title,
          body,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          linkedIssue: extractLinkedIssue(body),
          reviews,
          statusChecks,
        };
      }),
    );
  };
}

/**
 * Collapse PR issue comments into one verdict per review agent.
 *
 * Each review agent posts a comment beginning with its name and either
 * `APPROVED` or `CHANGES REQUESTED` — this is the same convention the merge
 * gate workflow scrapes. A later comment from the same agent overrides an
 * earlier one so the verdict reflects the most recent run.
 */
async function fetchReviews(
  client: Octokit,
  ref: RepoRef,
  prNumber: number,
): Promise<ReviewVerdict[]> {
  const comments = await client.paginate(client.issues.listComments, {
    owner: ref.owner,
    repo: ref.repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const latestByAgent = new Map<string, ReviewVerdict>();
  for (const comment of comments) {
    const verdict = parseVerdictComment(comment.body ?? "");
    if (verdict) latestByAgent.set(verdict.agent, verdict);
  }

  return REVIEW_AGENTS.map((agent) => latestByAgent.get(agent)).filter(
    (v): v is ReviewVerdict => v !== undefined,
  );
}

/**
 * Parse a verdict out of a PR comment body.
 *
 * Shape:
 *
 *   ## {Agent}
 *   **Verdict:** APPROVED
 *
 * Both the heading prefix and the verdict token matter — any comment that
 * looks like a normal human reply is skipped. Exported for testing via
 * state-level tests but not used outside this module.
 */
function parseVerdictComment(body: string): ReviewVerdict | null {
  const heading = body.match(/^##\s+(Arch|DX|Security|Perf|Test)\b/im);
  if (!heading || !heading[1]) return null;
  const agent = heading[1];

  const verdictMatch = body.match(/\b(APPROVED|CHANGES REQUESTED)\b/);
  if (!verdictMatch || !verdictMatch[1]) {
    return { agent, verdict: "PENDING" };
  }
  return {
    agent,
    verdict: verdictMatch[1] === "APPROVED" ? "APPROVED" : "CHANGES REQUESTED",
  };
}

/** Default `compareBranch` — counts commits `head` is behind `base`. */
function buildDefaultCompareBranch(
  client: Octokit,
): (ref: RepoRef, base: string, head: string) => Promise<number> {
  return async (ref, base, head) => {
    const { data } = await client.repos.compareCommitsWithBasehead({
      owner: ref.owner,
      repo: ref.repo,
      basehead: `${head}...${base}`,
    });
    // `ahead_by` on a `head...base` comparison is commits on `base` that
    // `head` is missing — i.e. exactly "how far behind `head` is".
    return typeof data.ahead_by === "number" ? data.ahead_by : 0;
  };
}

/**
 * Pull the CI status check rollup for a commit SHA.
 *
 * Uses `checks.listForRef` (GitHub Checks API) because that covers the
 * Actions jobs we care about. The older `commits.getCombinedStatusForRef`
 * endpoint is ignored here — we never publish commit statuses, only check
 * runs.
 */
async function fetchStatusChecks(
  client: Octokit,
  ref: RepoRef,
  sha: string,
): Promise<StatusCheckSummary[]> {
  const runs = await client.paginate(client.checks.listForRef, {
    owner: ref.owner,
    repo: ref.repo,
    ref: sha,
    per_page: 100,
  });
  return runs.map((run) => ({
    name: run.name,
    conclusion: run.conclusion ?? null,
  }));
}

/**
 * Default `readSessions` — list `.claw/sessions/*.json` and parse each one.
 *
 * Corrupt or unreadable files are silently skipped; the catch-all check
 * (CHECK 13) will flag any leftover inconsistency. Surfacing a filesystem
 * stat error here would halt the loop on a transient EACCES which is the
 * opposite of what we want.
 */
async function defaultReadSessions(
  cwd: string,
): Promise<Record<number, SessionRecord>> {
  const { sessionsDir } = resolveSetupPaths(cwd);
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return {};
  }

  const sessions: Record<number, SessionRecord> = {};
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(sessionsDir, entry);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSession(raw);
    if (parsed) {
      sessions[parsed.issueNumber] = parsed;
    }
  }
  return sessions;
}

/** Best-effort parse of a session file — returns null on any shape mismatch. */
function parseSession(raw: string): SessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const shape = value as {
    issueNumber?: unknown;
    sessionId?: unknown;
    fixAttempts?: unknown;
  };
  if (typeof shape.issueNumber !== "number" || !Number.isInteger(shape.issueNumber)) {
    return null;
  }
  if (typeof shape.sessionId !== "string" || shape.sessionId.length === 0) {
    return null;
  }
  const attempts =
    typeof shape.fixAttempts === "number" && Number.isFinite(shape.fixAttempts)
      ? shape.fixAttempts
      : 0;
  return {
    issueNumber: shape.issueNumber,
    sessionId: shape.sessionId,
    fixAttempts: attempts,
  };
}
