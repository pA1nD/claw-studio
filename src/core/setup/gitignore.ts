import { readFile, writeFile } from "node:fs/promises";
import { ClawError } from "../types/errors.js";

/** The gitignore entry `claw setup` ensures is present. */
export const CLAW_GITIGNORE_ENTRY = ".claw/";

/** Injectable filesystem seam for {@link ensureClawIsGitignored}. */
export interface GitignoreFs {
  /** Read `path` as UTF-8 or resolve to `null` when the file is missing. */
  readFile?: (path: string) => Promise<string | null>;
  /** Write `content` to `path` as UTF-8. */
  writeFile?: (path: string, content: string) => Promise<void>;
}

/**
 * Ensure `.claw/` appears in the project's `.gitignore`. Appends it idempotently
 * — if the file already lists `.claw/` (or an equivalent pattern) we do not
 * rewrite the file.
 *
 * A missing `.gitignore` is a legitimate state on a fresh repo; this function
 * creates one containing just the `.claw/` entry. An existing file gets the
 * entry appended with a leading blank line for readability.
 *
 * @param gitignorePath absolute path to the project's `.gitignore`
 * @param fs           optional filesystem seam for tests
 * @returns `true` when the file was updated, `false` when no change was needed
 * @throws {ClawError} when the file cannot be read or written
 */
export async function ensureClawIsGitignored(
  gitignorePath: string,
  fs: GitignoreFs = {},
): Promise<boolean> {
  const read = fs.readFile ?? defaultReadFile;
  const write = fs.writeFile ?? defaultWriteFile;

  let existing: string | null;
  try {
    existing = await read(gitignorePath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not read ${gitignorePath}.`,
      `Check filesystem permissions. Underlying error: ${detail}`,
    );
  }

  if (existing === null) {
    try {
      await write(gitignorePath, `${CLAW_GITIGNORE_ENTRY}\n`);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ClawError(
        `could not write ${gitignorePath}.`,
        `Check filesystem permissions. Underlying error: ${detail}`,
      );
    }
    return true;
  }

  if (gitignoreAlreadyCoversClaw(existing)) {
    return false;
  }

  const separator = existing.endsWith("\n") ? "" : "\n";
  const appended = `${existing}${separator}\n${CLAW_GITIGNORE_ENTRY}\n`;
  try {
    await write(gitignorePath, appended);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not write ${gitignorePath}.`,
      `Check filesystem permissions. Underlying error: ${detail}`,
    );
  }
  return true;
}

/**
 * Detect whether the existing `.gitignore` already ignores `.claw/`.
 *
 * Matches any of `.claw`, `.claw/`, `/.claw`, or `/.claw/` on its own line —
 * anything with a trailing comment or mid-line pattern is rare enough that
 * the duplicate append is harmless. Leading whitespace is tolerated because
 * some users indent gitignore sections under a header comment.
 *
 * @param content the full `.gitignore` contents
 * @returns true when `.claw/` is effectively ignored
 */
export function gitignoreAlreadyCoversClaw(content: string): boolean {
  const patterns = new Set([".claw", ".claw/", "/.claw", "/.claw/"]);
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    if (trimmed.startsWith("#")) return false;
    // Strip a trailing comment if the author put one on the same line.
    const withoutComment = trimmed.split("#")[0]?.trim() ?? "";
    return patterns.has(withoutComment);
  });
}

/** Default reader — returns `null` on ENOENT, re-throws any other error. */
async function defaultReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Default writer — `fs.writeFile(path, content, "utf8")`. */
async function defaultWriteFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

/** Narrow a thrown value to ENOENT. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as Record<string, unknown>)["code"] === "ENOENT";
}
