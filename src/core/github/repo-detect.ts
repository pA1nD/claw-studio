import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { ClawError } from "../types/errors.js";

/** A GitHub repository reference. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** Dependencies that can be injected for testing. */
export interface DetectRepoDeps {
  /** Reads a file, returning its contents or `null` if missing/unreadable. */
  readConfigFile?: (path: string) => Promise<string | null>;
  /** Returns the `origin` remote URL for the given cwd, or `null` if unavailable. */
  readGitRemote?: (cwd: string) => Promise<string | null>;
}

/** Options for {@link detectRepo}. */
export interface DetectRepoOptions extends DetectRepoDeps {
  /** Explicit repo string (e.g. from `--repo owner/repo`). Wins over all other sources. */
  explicit?: string;
  /** Working directory used to resolve `.claw/config.json` and the git remote. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Parse an `owner/repo` string.
 *
 * @param input a string in the form `owner/repo` (trailing `.git` is stripped)
 * @returns the parsed {@link RepoRef}
 * @throws {ClawError} when the string does not match `owner/repo`
 */
export function parseRepoString(input: string): RepoRef {
  const trimmed = input.trim();
  const match = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match || !match[1] || !match[2]) {
    // Deliberately do not echo `input` — a user accidentally passing a PAT
    // here would otherwise leak it into the terminal (screenshots, recordings,
    // scrollback). The hint is enough for the human to recover.
    throw new ClawError(
      "invalid --repo value.",
      "Use the owner/repo format (e.g. pA1nD/claw-studio).",
    );
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Parse a git remote URL into a {@link RepoRef}.
 *
 * Accepts the common GitHub remote URL shapes:
 *   - `git@github.com:owner/repo(.git)`
 *   - `https://github.com/owner/repo(.git)`
 *   - `ssh://git@github.com/owner/repo(.git)`
 *
 * @param url the remote URL reported by `git remote get-url`
 * @returns the parsed {@link RepoRef}, or `null` if the URL is not a GitHub remote
 */
export function parseGitRemoteUrl(url: string): RepoRef | null {
  const trimmed = url.trim();

  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (ssh && ssh[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] };

  const sshProto = trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshProto && sshProto[1] && sshProto[2]) return { owner: sshProto[1], repo: sshProto[2] };

  const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (https && https[1] && https[2]) return { owner: https[1], repo: https[2] };

  return null;
}

/**
 * Detect the current GitHub repository.
 *
 * Detection order:
 *   1. `options.explicit` — the `--repo` CLI flag
 *   2. `.claw/config.json` → `repo` field
 *   3. `git remote get-url origin`
 *
 * @param options detection options and injected dependencies
 * @returns the resolved {@link RepoRef}
 * @throws {ClawError} when no source yields a valid repo reference
 */
export async function detectRepo(options: DetectRepoOptions = {}): Promise<RepoRef> {
  const cwd = options.cwd ?? process.cwd();
  const readConfigFile = options.readConfigFile ?? defaultReadConfigFile;
  const readGitRemote = options.readGitRemote ?? defaultReadGitRemote;

  // 1. Explicit --repo flag wins
  if (options.explicit) {
    return parseRepoString(options.explicit);
  }

  // 2. .claw/config.json in the current directory
  const configPath = join(cwd, ".claw", "config.json");
  const raw = await readConfigFile(configPath);
  if (raw !== null) {
    const fromConfig = extractRepoFromConfig(raw);
    if (fromConfig) return fromConfig;
  }

  // 3. git remote get-url origin
  const remote = await readGitRemote(cwd);
  if (remote) {
    const parsed = parseGitRemoteUrl(remote);
    if (parsed) return parsed;
  }

  // 4. No source yielded a repo — halt with a human-readable message
  throw new ClawError(
    "could not detect a GitHub repo.",
    "Pass --repo owner/repo or run from inside a git repository.",
  );
}

/**
 * Extract the `repo` field from `.claw/config.json` contents.
 * Returns `null` when the JSON is invalid or the `repo` field is missing.
 */
function extractRepoFromConfig(raw: string): RepoRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const repo = (parsed as { repo?: unknown }).repo;
  if (typeof repo !== "string" || repo.length === 0) return null;
  try {
    return parseRepoString(repo);
  } catch {
    return null;
  }
}

/** Default implementation: read a file, return `null` on any error. */
async function defaultReadConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Default implementation: run `git remote get-url origin`, return `null` on any error. */
async function defaultReadGitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
