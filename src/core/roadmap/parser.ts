import { Buffer } from "node:buffer";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import { parseRepoString } from "../github/repo-detect.js";

/**
 * A milestone resolved from ROADMAP.md together with its GitHub issues.
 *
 * The loop reads this on every cycle to know what to build next. The name is
 * exactly the label that appears on GitHub issues (e.g. `v0.1`) — whatever
 * trailing description lives on the ROADMAP heading is discarded.
 */
export interface Milestone {
  /** Milestone name — e.g. `"v0.1"`. Matches the GitHub label exactly. */
  name: string;
  /** Issues labeled with the milestone, ordered by issue number ascending. */
  issues: Issue[];
}

/** A GitHub issue belonging to a milestone. */
export interface Issue {
  /** GitHub issue number. */
  number: number;
  /** Issue title. */
  title: string;
  /** Whether the issue is currently open or closed on GitHub. */
  state: "open" | "closed";
  /** All labels on the issue. */
  labels: string[];
  /** Issue body — empty string when GitHub returns `null`. */
  body: string;
}

/**
 * Dependencies injected into {@link parseRoadmap}.
 *
 * The defaults call the real GitHub API via the passed-in Octokit client.
 * Tests override these two seams instead of building a mock Octokit — there is
 * no need to exercise Octokit's own serialisation path here.
 */
export interface ParseRoadmapDeps {
  /**
   * Read `ROADMAP.md` from the repo root. Resolve to `null` when the file
   * does not exist — any other error must surface unchanged.
   */
  readRoadmap?: (owner: string, repo: string) => Promise<string | null>;
  /**
   * List GitHub issues that carry `label`. Must return open AND closed issues,
   * and must exclude pull requests (the underlying issues endpoint lumps them
   * together).
   */
  listIssuesForLabel?: (
    owner: string,
    repo: string,
    label: string,
  ) => Promise<Issue[]>;
}

/**
 * Read `ROADMAP.md` from the target repo, find the current milestone, and
 * return it together with every GitHub issue labeled with that milestone —
 * ordered by issue number ascending.
 *
 * This is the first thing the loop runs on every cycle. It is a pure read —
 * no writes, no mutations, no side effects beyond the GitHub API calls.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param repo   the target repo in the form `owner/repo`
 * @param deps   optional injected seams for testing
 * @returns the resolved {@link Milestone}
 * @throws {ClawError} when the repo string is malformed
 * @throws {ClawError} when `ROADMAP.md` does not exist in the repo
 * @throws {ClawError} when no `## Current milestone:` line is present
 */
export async function parseRoadmap(
  client: Octokit,
  repo: string,
  deps: ParseRoadmapDeps = {},
): Promise<Milestone> {
  const ref = parseRepoString(repo);
  const readRoadmap = deps.readRoadmap ?? buildDefaultReadRoadmap(client);
  const listIssuesForLabel =
    deps.listIssuesForLabel ?? buildDefaultListIssuesForLabel(client);

  const content = await readRoadmap(ref.owner, ref.repo);
  if (content === null) {
    throw new ClawError(
      `no ROADMAP.md found in ${ref.owner}/${ref.repo}.`,
      "Add a ROADMAP.md with at least one milestone to the repo root before the loop can start.",
    );
  }

  const name = extractCurrentMilestone(content);
  if (name === null) {
    throw new ClawError(
      "no current milestone in ROADMAP.md.",
      "Add a line near the top: ## Current milestone: vX.X",
    );
  }

  const issues = (await listIssuesForLabel(ref.owner, ref.repo, name))
    .slice()
    .sort((a, b) => a.number - b.number);

  return { name, issues };
}

/**
 * Extract the current milestone name from ROADMAP.md.
 *
 * Matches the first line of the form `## Current milestone: {name}` — only the
 * first whitespace-delimited token after the colon is returned, so trailing
 * descriptive text (e.g. ` — The Loop`) is ignored. This keeps the name aligned
 * with the short label used on GitHub issues.
 *
 * @param content the full `ROADMAP.md` contents
 * @returns the milestone name (e.g. `"v0.1"`), or `null` when no matching line exists
 */
export function extractCurrentMilestone(content: string): string | null {
  // Normalise CRLF → LF so the `^` anchor matches regardless of how the file
  // was saved. Without this, a Windows-authored ROADMAP would slip past the
  // regex and surface as the less-helpful "no current milestone" error.
  const normalised = content.replace(/\r\n/g, "\n");
  const match = normalised.match(/^##\s+Current milestone:\s*(\S+)/m);
  if (!match || !match[1]) return null;
  return match[1];
}

/**
 * Build the default `readRoadmap` implementation backed by Octokit.
 *
 * A 404 from the contents endpoint is the signal that the file does not exist
 * — every other error (auth failure, rate limit, server error) is re-thrown so
 * the human does not silently lose the loop to a transient GitHub issue.
 */
function buildDefaultReadRoadmap(
  client: Octokit,
): (owner: string, repo: string) => Promise<string | null> {
  return async (owner, repo) => {
    try {
      const response = await client.repos.getContent({
        owner,
        repo,
        path: "ROADMAP.md",
      });
      return decodeContentResponse(response.data);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };
}

/**
 * Build the default `listIssuesForLabel` implementation backed by Octokit.
 *
 * Uses `paginate` so milestones with more than 100 issues are not silently
 * truncated. Pull requests are filtered out because the GitHub issues endpoint
 * returns both issues and PRs and we only care about the former here.
 */
function buildDefaultListIssuesForLabel(
  client: Octokit,
): (owner: string, repo: string, label: string) => Promise<Issue[]> {
  return async (owner, repo, label) => {
    const rows = await client.paginate(client.issues.listForRepo, {
      owner,
      repo,
      labels: label,
      state: "all",
      per_page: 100,
    });
    return rows
      .filter((row) => !isPullRequest(row))
      .map(normaliseIssueRow);
  };
}

/** The subset of the GitHub contents response we decode. */
interface ContentsResponseShape {
  content?: unknown;
  encoding?: unknown;
}

/**
 * Decode the body of `GET /repos/{owner}/{repo}/contents/{path}` for a file.
 *
 * The endpoint can return an array (directory listing) or a non-file type — in
 * both cases we return `null` because ROADMAP.md exists but is not readable as
 * a text file, which is functionally the same as missing.
 */
function decodeContentResponse(data: unknown): string | null {
  if (Array.isArray(data)) return null;
  if (typeof data !== "object" || data === null) return null;
  const shape = data as ContentsResponseShape;
  if (typeof shape.content !== "string") return null;
  if (shape.encoding === "base64") {
    return Buffer.from(shape.content, "base64").toString("utf8");
  }
  return shape.content;
}

/** A GitHub issue row as returned by `issues.listForRepo` — only the fields we consume. */
interface IssueRow {
  number: number;
  title: string;
  state: string;
  labels?: Array<string | { name?: string | null } | null> | null;
  body?: string | null;
  pull_request?: unknown;
}

/** True when an issues-endpoint row actually represents a pull request. */
function isPullRequest(row: IssueRow): boolean {
  return row.pull_request !== undefined && row.pull_request !== null;
}

/** Map a raw GitHub issue row to the narrower {@link Issue} shape. */
function normaliseIssueRow(row: IssueRow): Issue {
  return {
    number: row.number,
    title: row.title,
    state: row.state === "closed" ? "closed" : "open",
    labels: (row.labels ?? [])
      .map((entry) =>
        typeof entry === "string" ? entry : entry?.name ?? null,
      )
      .filter((entry): entry is string => entry !== null && entry.length > 0),
    body: row.body ?? "",
  };
}

/** Detect a GitHub 404 regardless of how Octokit dressed up the error. */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}
