import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { ClawError } from "../types/errors.js";

/**
 * A parsed `.claw/.env` file — plain `KEY=VALUE` lines compatible with
 * `dotenv`. Only the keys Claw Studio cares about are first-class fields;
 * unknown lines are preserved in {@link EnvFile.raw} so a future write does
 * not clobber user additions.
 */
export interface EnvFile {
  /** `GITHUB_PAT` value, when present. */
  GITHUB_PAT?: string;
  /** `CLAUDE_CODE_OAUTH_TOKEN` value, when present. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** All raw `KEY=VALUE` pairs parsed from the file, in read order. */
  raw: Map<string, string>;
}

/** Injectable filesystem seam for {@link readEnvFile} and {@link writeEnvFile}. */
export interface EnvFileFs {
  /** Read `path` as UTF-8 or resolve to `null` when the file is missing. */
  readFile?: (path: string) => Promise<string | null>;
  /** Write `content` to `path`, creating parent directories as needed. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Create `path` as a directory, recursively, no error if it exists. */
  mkdir?: (path: string) => Promise<void>;
  /** Restrict `path` to `0600` so only the current user can read it. */
  chmod?: (path: string, mode: number) => Promise<void>;
}

/**
 * Read `.claw/.env` at `path` and return a structured {@link EnvFile}.
 *
 * Returns an empty `EnvFile` (all fields undefined, empty `raw`) when the
 * file does not exist — that path is the first-run case and must not fail.
 * Any other read error surfaces as a typed {@link ClawError} because it
 * indicates a real problem the human must resolve (permissions, disk).
 *
 * @param path absolute path to `.claw/.env`
 * @param fs   optional filesystem seam for testing
 * @returns parsed env file, empty when the file does not exist
 * @throws {ClawError} when parsing fails on a malformed line
 */
export async function readEnvFile(
  path: string,
  fs: EnvFileFs = {},
): Promise<EnvFile> {
  const read = fs.readFile ?? defaultReadFile;
  const raw = await read(path);
  if (raw === null) {
    return { raw: new Map() };
  }
  return parseEnvFile(raw);
}

/**
 * Write `.claw/.env` atomically, restricting permissions to `0600` so
 * other local users cannot read the tokens.
 *
 * The file is serialised in a stable order (GITHUB_PAT, CLAUDE_CODE_OAUTH_TOKEN,
 * then anything else from {@link EnvFile.raw}) so repeated writes produce
 * identical bytes when inputs are unchanged.
 *
 * @param path absolute path to `.claw/.env`
 * @param env  structured env file to serialise
 * @param fs   optional filesystem seam for testing
 * @throws {ClawError} when the file cannot be written
 */
export async function writeEnvFile(
  path: string,
  env: EnvFile,
  fs: EnvFileFs = {},
): Promise<void> {
  const write = fs.writeFile ?? defaultWriteFile;
  const ensureDir = fs.mkdir ?? defaultMkdir;
  const restrict = fs.chmod ?? defaultChmod;

  await ensureDir(dirname(path));
  await write(path, serializeEnvFile(env));
  try {
    // 0o600 matches the convention SSH keys and GitHub CLI use for
    // tokens on disk. Failure is tolerated on filesystems that do not
    // support chmod (Windows FAT) — the file still exists, the caller
    // just doesn't get the UNIX-level guarantee.
    await restrict(path, 0o600);
  } catch {
    // Non-fatal by design — Windows has no POSIX mode bits.
  }
}

/**
 * Parse `.claw/.env` content. Ignores blank lines and `#` comment lines.
 *
 * Accepts simple `KEY=VALUE` — values are trimmed, with surrounding
 * single- or double-quotes stripped. Returns every line in the `raw`
 * map so an unrecognised key is preserved across rewrites.
 *
 * @param content UTF-8 file contents
 * @returns structured env file
 * @throws {ClawError} when a non-blank, non-comment line is missing `=`
 */
export function parseEnvFile(content: string): EnvFile {
  const raw = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new ClawError(
        `.claw/.env has a malformed line (line ${i + 1}).`,
        "Each line must be KEY=VALUE. Delete .claw/.env and re-run `claw setup`.",
      );
    }
    const key = trimmed.slice(0, eq).trim();
    const value = stripSurroundingQuotes(trimmed.slice(eq + 1).trim());
    raw.set(key, value);
  }
  const env: EnvFile = { raw };
  const pat = raw.get("GITHUB_PAT");
  if (pat !== undefined && pat.length > 0) env.GITHUB_PAT = pat;
  const token = raw.get("CLAUDE_CODE_OAUTH_TOKEN");
  if (token !== undefined && token.length > 0) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return env;
}

/**
 * Serialise an {@link EnvFile} back into `KEY=VALUE` lines. The known
 * Claw Studio keys come first so humans can find them quickly; any other
 * keys from {@link EnvFile.raw} are appended in insertion order.
 *
 * @param env structured env file
 * @returns UTF-8 string ending with a trailing newline
 */
export function serializeEnvFile(env: EnvFile): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    out.push(`${key}=${value}`);
    seen.add(key);
  };
  push("GITHUB_PAT", env.GITHUB_PAT);
  push("CLAUDE_CODE_OAUTH_TOKEN", env.CLAUDE_CODE_OAUTH_TOKEN);
  for (const [key, value] of env.raw) {
    if (seen.has(key)) continue;
    if (value.length === 0) continue;
    out.push(`${key}=${value}`);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Merge `updates` on top of `base`, preferring defined non-empty values
 * from `updates`. Unknown keys from `base.raw` are preserved. Used when
 * `claw setup` writes tokens resolved from the environment without
 * clobbering anything else a human put in the file.
 *
 * @param base    the EnvFile currently on disk
 * @param updates fields to set (undefined/empty = no change)
 * @returns a merged EnvFile suitable for {@link writeEnvFile}
 */
export function mergeEnvFile(base: EnvFile, updates: Partial<EnvFile>): EnvFile {
  const raw = new Map(base.raw);
  const merged: EnvFile = { raw };
  const pat =
    updates.GITHUB_PAT !== undefined && updates.GITHUB_PAT.length > 0
      ? updates.GITHUB_PAT
      : base.GITHUB_PAT;
  const token =
    updates.CLAUDE_CODE_OAUTH_TOKEN !== undefined &&
    updates.CLAUDE_CODE_OAUTH_TOKEN.length > 0
      ? updates.CLAUDE_CODE_OAUTH_TOKEN
      : base.CLAUDE_CODE_OAUTH_TOKEN;
  if (pat !== undefined && pat.length > 0) {
    merged.GITHUB_PAT = pat;
    raw.set("GITHUB_PAT", pat);
  }
  if (token !== undefined && token.length > 0) {
    merged.CLAUDE_CODE_OAUTH_TOKEN = token;
    raw.set("CLAUDE_CODE_OAUTH_TOKEN", token);
  }
  return merged;
}

/**
 * Strip a single layer of matching surrounding quotes, matching
 * `dotenv`'s behaviour. `"foo"` → `foo`, `'bar'` → `bar`, `"mis'` → `"mis'`.
 */
function stripSurroundingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Default disk-backed reader — returns `null` on ENOENT (first-run case),
 * re-throws any other error so permissions or I/O problems surface cleanly
 * instead of being mis-reported as "file does not exist".
 */
async function defaultReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Narrow a thrown value to ENOENT. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<string, unknown>)["code"] === "ENOENT";
}

/** Default disk-backed writer — creates the file if it does not exist. */
async function defaultWriteFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

/** Default mkdir — `recursive: true`. */
async function defaultMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Default chmod — pass-through to `node:fs/promises`. */
async function defaultChmod(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}
