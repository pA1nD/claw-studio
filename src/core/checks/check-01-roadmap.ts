import { Buffer } from "node:buffer";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";
import type { CheckResult } from "./types.js";

/**
 * CHECK 1 — `ROADMAP.md` exists in the target repository.
 *
 * Reads the file from the repo root via the GitHub contents API. A 404 (file
 * missing) returns a halting CheckResult. Any other failure (auth, rate limit,
 * server) is re-thrown — the loop must not silently treat transient GitHub
 * errors as a missing roadmap.
 *
 * On success, the raw file contents are returned alongside `passed: true` so
 * CHECK 2 can extract the milestone without a second GitHub call.
 */
export type Check01Result =
  | { passed: true; content: string }
  | (Extract<CheckResult, { passed: false }>);

/** Dependencies injected for testing CHECK 1. */
export interface Check01Deps {
  /**
   * Reads `ROADMAP.md` from the repo root. Returns `null` on 404, the file
   * contents otherwise. Any non-404 error must be thrown.
   */
  readRoadmap?: (ref: RepoRef) => Promise<string | null>;
}

/**
 * Run CHECK 1 against the target repo.
 *
 * @param client an Octokit client produced by `createClient()`
 * @param ref    the target repository
 * @param deps   optional injected seam for testing
 * @returns {@link Check01Result} — `passed: true` carries the file contents
 */
export async function check01Roadmap(
  client: Octokit,
  ref: RepoRef,
  deps: Check01Deps = {},
): Promise<Check01Result> {
  const readRoadmap = deps.readRoadmap ?? buildDefaultReadRoadmap(client);
  const content = await readRoadmap(ref);
  if (content === null) {
    return {
      passed: false,
      error: new ClawError(
        `no ROADMAP.md found in ${ref.owner}/${ref.repo}.`,
        "Add a ROADMAP.md with at least one milestone to the repo root before the loop can start.",
      ),
    };
  }
  return { passed: true, content };
}

/**
 * Build the default Octokit-backed `readRoadmap` implementation.
 *
 * Mirrors the fetcher in `src/core/roadmap/parser.ts` deliberately — when the
 * GitHub auth strategy or contents-API behaviour changes, both call sites
 * benefit from updating one place. Kept private here so the parser stays the
 * canonical "load and parse" entry point and CHECK 1 stays a thin status read.
 */
function buildDefaultReadRoadmap(
  client: Octokit,
): (ref: RepoRef) => Promise<string | null> {
  return async (ref) => {
    try {
      const response = await client.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: "ROADMAP.md",
      });
      return decodeContentResponse(response.data);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  };
}

/** The subset of the GitHub contents response we decode. */
interface ContentsResponseShape {
  content?: unknown;
  encoding?: unknown;
}

/** Decode `GET /repos/{owner}/{repo}/contents/ROADMAP.md` into the file body. */
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

/** Detect a GitHub 404 regardless of how Octokit dressed up the error. */
function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 404
  );
}
