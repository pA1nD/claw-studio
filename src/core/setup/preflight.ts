import { stat } from "node:fs/promises";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";
import { resolveRequiredPaths, resolveSetupPaths } from "./paths.js";

/**
 * A pre-flight check, identified by an ordinal for deterministic ordering.
 *
 * The loop halts on the first failed check, so the order is load-bearing:
 *   1. Repo accessible via GitHub API
 *   2. README.md exists locally
 *   3. ROADMAP.md exists locally
 *   4. No Claw Studio files already exist (skipped when --overwrite is passed)
 */
export type PreflightCheckId = 1 | 2 | 3 | 4;

/** Options accepted by {@link runPreflight}. */
export interface PreflightOptions {
  /** Target repository — drives the API reachability check. */
  ref: RepoRef;
  /** Working directory to resolve README, ROADMAP, and `.claw/` against. */
  cwd: string;
  /** When true, skip CHECK 4 (existing Claw Studio files). */
  overwrite: boolean;
  /** Injected dependencies for testing. */
  deps?: PreflightDeps;
}

/** Injectable dependencies so the checks can be unit-tested without the real filesystem or network. */
export interface PreflightDeps {
  /** Returns `true` if the repo can be read via the GitHub API with the current credentials. */
  canAccessRepo?: (ref: RepoRef) => Promise<boolean>;
  /** Returns `true` if `path` exists as a regular file. */
  fileExists?: (path: string) => Promise<boolean>;
}

/**
 * Run every pre-flight check in order. Returns on the first success — when all
 * four pass (or three, with `--overwrite`) — and throws a {@link ClawError}
 * on the first failure.
 *
 * First-failure-halts is intentional: the loop philosophy says we never
 * continue past an unknown state, and setup is the first cycle the loop runs.
 *
 * @param options ref + cwd + overwrite flag + optional injected deps
 * @throws {ClawError} on the first failed check
 */
export async function runPreflight(options: PreflightOptions): Promise<void> {
  const { ref, cwd, overwrite } = options;
  const canAccessRepo = options.deps?.canAccessRepo ?? defaultCanAccessRepo;
  const fileExists = options.deps?.fileExists ?? defaultFileExists;

  await check1RepoAccessible(ref, canAccessRepo);
  await check2ReadmeExists(cwd, fileExists);
  await check3RoadmapExists(cwd, fileExists);
  if (!overwrite) {
    await check4NoClawFilesYet(cwd, fileExists);
  }
}

/** CHECK 1 — the current credentials can read the target repo. */
async function check1RepoAccessible(
  ref: RepoRef,
  canAccessRepo: (ref: RepoRef) => Promise<boolean>,
): Promise<void> {
  const accessible = await canAccessRepo(ref);
  if (!accessible) {
    throw new ClawError(
      `cannot access ${ref.owner}/${ref.repo}.`,
      "Check your GITHUB_PAT has repo and workflow scope.",
    );
  }
}

/** CHECK 2 — README.md exists at the working directory root. */
async function check2ReadmeExists(
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  const { readme } = resolveRequiredPaths(cwd);
  if (!(await fileExists(readme))) {
    throw new ClawError(
      "no README.md found.",
      "Add a README.md describing your project before running setup.",
    );
  }
}

/** CHECK 3 — ROADMAP.md exists at the working directory root. */
async function check3RoadmapExists(
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  const { roadmap } = resolveRequiredPaths(cwd);
  if (!(await fileExists(roadmap))) {
    throw new ClawError(
      "no ROADMAP.md found.",
      "Add a ROADMAP.md with at least one milestone before running setup. See github.com/pA1nD/claw-studio for the expected format.",
    );
  }
}

/** CHECK 4 — no Claw Studio files exist yet. Skipped when `--overwrite` is passed. */
async function check4NoClawFilesYet(
  cwd: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  const paths = resolveSetupPaths(cwd);
  const candidates: Array<{ label: string; path: string }> = [
    { label: ".claw/CLAUDE.md", path: paths.claudeMd },
    { label: ".claw/config.json", path: paths.configJson },
    { label: ".github/workflows/ci.yml", path: paths.ciYml },
  ];
  for (const { label, path } of candidates) {
    if (await fileExists(path)) {
      throw new ClawError(
        `${label} already exists.`,
        "Run with --overwrite to replace all Claw Studio files. Onboarding an existing repo without overwrite is coming in a later version.",
      );
    }
  }
}

/**
 * Build a {@link PreflightDeps.canAccessRepo} implementation backed by an
 * injected Octokit client.
 *
 * Keeping this separate from the default means the setup orchestrator can
 * create one shared client up front and pass it to both preflight and the
 * branch-protection / runners stages, instead of each stage calling
 * `createClient()` independently.
 */
export function canAccessRepoVia(
  octokit: Pick<Octokit, "repos">,
): (ref: RepoRef) => Promise<boolean> {
  return async (ref) => {
    try {
      await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
      return true;
    } catch {
      return false;
    }
  };
}

/** Default: assume inaccessible until proven otherwise — tests must inject. */
async function defaultCanAccessRepo(): Promise<boolean> {
  return false;
}

/** Default: `fs.stat` — returns `true` for any existing filesystem entry. */
async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
