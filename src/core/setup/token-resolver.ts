import { ClawError } from "../types/errors.js";
import { readEnvFile } from "./env-file.js";
import type { EnvFileFs } from "./env-file.js";
import { resolveSetupPaths } from "./paths.js";

/** A single resolved token and where it came from — surfaced to the UI for transparency. */
export interface ResolvedToken {
  /** The token value, already trimmed. Never empty. */
  value: string;
  /** Where the token was found, highest priority winning. */
  source: TokenSource;
}

/** Source of a resolved token, ordered by priority. */
export type TokenSource = "flag" | "env" | "env-file";

/** Which token is being resolved — used only for error messages. */
export type TokenName = "GITHUB_PAT" | "CLAUDE_CODE_OAUTH_TOKEN";

/** The two tokens the setup flow needs. */
export interface ResolvedTokens {
  /** GitHub PAT — needed for every API call. */
  githubPat: ResolvedToken;
  /** Claude Code OAuth token — pushed to the repo as an Actions secret. */
  claudeToken: ResolvedToken;
}

/** Optional CLI-flag overrides (highest priority). */
export interface TokenOverrides {
  /** `--github-pat <value>` — beats env and .claw/.env. */
  githubPat?: string;
  /** `--claude-token <value>` — beats env and .claw/.env. */
  claudeToken?: string;
}

/** Injectable seams for {@link resolveTokens}. */
export interface ResolveTokensDeps {
  /** Process env accessor — defaults to `process.env`. */
  readEnv?: (key: string) => string | undefined;
  /** `.claw/.env` reader — defaults to the disk-backed {@link readEnvFile}. */
  readEnvFile?: typeof readEnvFile;
  /** Forwarded to {@link readEnvFile} — tests inject to bypass disk. */
  envFileFs?: EnvFileFs;
}

/**
 * Resolve both tokens in priority order — CLI flag → environment variable
 * → `.claw/.env`. If any token is still missing after all three sources,
 * halts with a typed {@link ClawError} that explains every source the
 * human can use to supply it.
 *
 * The resolution is a pure function of its inputs (env, flags, env file),
 * so `claw setup` can call it before any mutation happens. Tokens are
 * only persisted to `.claw/.env` after a successful resolution.
 *
 * @param cwd       target working directory (where `.claw/.env` lives)
 * @param overrides CLI-flag values — empty/undefined means "not passed"
 * @param deps      optional injected seams for testing
 * @returns both resolved tokens with their source
 * @throws {ClawError} when a token cannot be found in any source
 */
export async function resolveTokens(
  cwd: string,
  overrides: TokenOverrides = {},
  deps: ResolveTokensDeps = {},
): Promise<ResolvedTokens> {
  const readEnv = deps.readEnv ?? defaultReadEnv;
  const readFile = deps.readEnvFile ?? readEnvFile;
  const paths = resolveSetupPaths(cwd);

  // One disk read for both tokens — the file is small and parsing happens
  // in-memory, so doing this once keeps a token-resolution test from
  // coupling two independent assertions against the same stub.
  const envFile = await readFile(paths.envFile, deps.envFileFs);

  const githubPat = resolveOne(
    "GITHUB_PAT",
    overrides.githubPat,
    readEnv("GITHUB_PAT"),
    envFile.GITHUB_PAT,
  );
  const claudeToken = resolveOne(
    "CLAUDE_CODE_OAUTH_TOKEN",
    overrides.claudeToken,
    readEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    envFile.CLAUDE_CODE_OAUTH_TOKEN,
  );
  return { githubPat, claudeToken };
}

/**
 * Resolve a single token against the three candidate sources. Exposed so
 * callers that only need one of the two tokens (e.g. a hypothetical
 * future command that only uses the PAT) can reuse the same rules.
 *
 * @param name     token name, only used in error messages
 * @param override CLI-flag value (or undefined)
 * @param envVal   env-var value (or undefined)
 * @param fileVal  `.claw/.env` value (or undefined)
 * @returns the resolved token plus the source that produced it
 * @throws {ClawError} when all three sources are missing
 */
export function resolveOne(
  name: TokenName,
  override: string | undefined,
  envVal: string | undefined,
  fileVal: string | undefined,
): ResolvedToken {
  const flagTrimmed = override?.trim();
  if (flagTrimmed !== undefined && flagTrimmed.length > 0) {
    return { value: flagTrimmed, source: "flag" };
  }
  const envTrimmed = envVal?.trim();
  if (envTrimmed !== undefined && envTrimmed.length > 0) {
    return { value: envTrimmed, source: "env" };
  }
  const fileTrimmed = fileVal?.trim();
  if (fileTrimmed !== undefined && fileTrimmed.length > 0) {
    return { value: fileTrimmed, source: "env-file" };
  }
  throw new ClawError(
    `${name} is not set.`,
    `Pass ${flagFor(name)}, export ${name}, or run \`claw setup\` once with it in your environment so it persists to .claw/.env.`,
  );
}

/** The CLI flag that overrides a given token name — mirrors the setup command options. */
function flagFor(name: TokenName): string {
  return name === "GITHUB_PAT" ? "--github-pat" : "--claude-token";
}

/** Default env reader — reads from `process.env`. */
function defaultReadEnv(key: string): string | undefined {
  return process.env[key];
}
