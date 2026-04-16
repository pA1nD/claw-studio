import { readFile } from "node:fs/promises";
import type { RepoRef } from "../github/repo-detect.js";
import { ClawError } from "../types/errors.js";
import { resolveSetupPaths } from "./paths.js";

/** Shape of `.claw/config.json` written by setup. */
export interface ClawConfig {
  /** Full `owner/repo` the loop targets. */
  repo: string;
  /** How often the loop polls GitHub, in seconds. */
  pollInterval: number;
  /** The Claw Studio version that wrote this file. */
  clawVersion: string;
  /**
   * Number of Docker-backed self-hosted runners `claw setup` provisions
   * via `.claw/runners/docker-compose.yml`. Default: {@link DEFAULT_RUNNER_COUNT}.
   */
  runnerCount: number;
}

/** The current Claw Studio version that setup stamps into `config.json`. */
export const CURRENT_CLAW_VERSION = "0.0.1";

/** Default poll interval in seconds, matching `.env.example`. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/**
 * Default number of Docker-backed self-hosted runners to provision.
 *
 * Six is the number that matches the five review agents + one implementation
 * job firing simultaneously — chosen so a single PR's review pipeline does
 * not starve behind a running implementation agent.
 */
export const DEFAULT_RUNNER_COUNT = 6;

/**
 * Build the structured {@link ClawConfig} for a target repo.
 *
 * @param ref target repository the config belongs to
 * @param clawVersion version to stamp — defaults to {@link CURRENT_CLAW_VERSION}
 * @param runnerCount runners to provision — defaults to {@link DEFAULT_RUNNER_COUNT}
 * @returns the config object
 */
export function buildConfig(
  ref: RepoRef,
  clawVersion: string = CURRENT_CLAW_VERSION,
  runnerCount: number = DEFAULT_RUNNER_COUNT,
): ClawConfig {
  return {
    repo: `${ref.owner}/${ref.repo}`,
    pollInterval: DEFAULT_POLL_INTERVAL_SECONDS,
    clawVersion,
    runnerCount,
  };
}

/**
 * Serialize a {@link ClawConfig} as JSON with a trailing newline.
 *
 * Two-space indentation matches the example in issue #18 and the style
 * emitted by `npm`, so diffs stay clean when a human inspects the file.
 *
 * @param config structured config
 * @returns the exact bytes to write to `.claw/config.json`
 */
export function serializeConfig(config: ClawConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Injectable filesystem seam for {@link readConfig} so tests skip disk I/O. */
export interface ReadConfigDeps {
  /**
   * Read a UTF-8 file. Must resolve to `null` when the file is missing — any
   * other error must surface unchanged so a permissions failure doesn't get
   * mis-reported as "no config file".
   */
  readFile?: (path: string) => Promise<string | null>;
}

/**
 * Read and validate `.claw/config.json` for a target project.
 *
 * Lives in the core setup module so every caller — the loop, future
 * dashboard processes, programmatic API consumers — shares the same parsing
 * and the same default fallbacks. CLI commands that need a config thread
 * through here rather than re-implementing the parsing.
 *
 * Halts with a typed {@link ClawError} when the file is missing, invalid
 * JSON, or not a JSON object. When individual fields are missing, falls back
 * to the documented defaults: `pollInterval: 60`, `clawVersion:
 * CURRENT_CLAW_VERSION`. The `repo` field falls back to `detectedRepo` so
 * `claw start --repo owner/x` keeps working when the config has been
 * partially clobbered.
 *
 * @param cwd          target project working directory (where `.claw/` lives)
 * @param detectedRepo fallback repo string when the config has no `repo` field
 * @param deps         optional filesystem seam for testing
 * @returns the parsed {@link ClawConfig}
 * @throws {ClawError} when the file is missing, invalid JSON, or not an object
 */
export async function readConfig(
  cwd: string,
  detectedRepo: string,
  deps: ReadConfigDeps = {},
): Promise<ClawConfig> {
  const read = deps.readFile ?? defaultReadConfigFile;
  const path = resolveSetupPaths(cwd).configJson;
  const raw = await read(path);
  if (raw === null) {
    throw new ClawError(
      "no .claw/config.json found.",
      "Run `claw setup` first to initialise this repo for the loop.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClawError(
      ".claw/config.json is not valid JSON.",
      "Re-run `claw setup --overwrite` to regenerate it.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClawError(
      ".claw/config.json was not a JSON object.",
      "Re-run `claw setup --overwrite` to regenerate it.",
    );
  }
  const shape = parsed as Partial<ClawConfig>;
  const repo =
    typeof shape.repo === "string" && shape.repo.length > 0
      ? shape.repo
      : detectedRepo;
  const pollInterval =
    typeof shape.pollInterval === "number" && shape.pollInterval > 0
      ? shape.pollInterval
      : DEFAULT_POLL_INTERVAL_SECONDS;
  const clawVersion =
    typeof shape.clawVersion === "string" && shape.clawVersion.length > 0
      ? shape.clawVersion
      : CURRENT_CLAW_VERSION;
  const runnerCount =
    typeof shape.runnerCount === "number" &&
    Number.isInteger(shape.runnerCount) &&
    shape.runnerCount > 0
      ? shape.runnerCount
      : DEFAULT_RUNNER_COUNT;
  return { repo, pollInterval, clawVersion, runnerCount };
}

/** Default disk-backed config reader — returns `null` on any read error. */
async function defaultReadConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
