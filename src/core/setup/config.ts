import type { RepoRef } from "../github/repo-detect.js";

/** Shape of `.claw/config.json` written by setup. */
export interface ClawConfig {
  /** Full `owner/repo` the loop targets. */
  repo: string;
  /** How often the loop polls GitHub, in seconds. */
  pollInterval: number;
  /** The Claw Studio version that wrote this file. */
  clawVersion: string;
}

/** The current Claw Studio version that setup stamps into `config.json`. */
export const CURRENT_CLAW_VERSION = "0.0.1";

/** Default poll interval in seconds, matching `.env.example`. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/**
 * Build the structured {@link ClawConfig} for a target repo.
 *
 * @param ref target repository the config belongs to
 * @param clawVersion version to stamp — defaults to {@link CURRENT_CLAW_VERSION}
 * @returns the config object
 */
export function buildConfig(
  ref: RepoRef,
  clawVersion: string = CURRENT_CLAW_VERSION,
): ClawConfig {
  return {
    repo: `${ref.owner}/${ref.repo}`,
    pollInterval: DEFAULT_POLL_INTERVAL_SECONDS,
    clawVersion,
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
