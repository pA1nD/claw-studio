import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSetupPaths } from "../setup/paths.js";
import type { SessionFile } from "../checks/types.js";

/**
 * Re-export the canonical {@link SessionFile} shape so callers can pull it
 * from the agents module without reaching into `core/checks/types.ts` for
 * what is logically an agent concern.
 *
 * The single source of truth lives in `core/checks/types.ts` because CHECK 11
 * already reads it — the implementation agent owns the write side.
 */
export type { SessionFile } from "../checks/types.js";

/** Injectable filesystem seam so tests can drive the I/O paths without disk access. */
export interface SessionFs {
  /** Read a file as UTF-8. Must resolve to `null` when the file does not exist. */
  readFile: (path: string) => Promise<string | null>;
  /** Write `contents` to `path`, creating parent directories as needed. */
  writeFile: (path: string, contents: string) => Promise<void>;
  /** Delete `path`. Must be a no-op when the file does not exist. */
  removeFile: (path: string) => Promise<void>;
}

/**
 * Build the canonical path for a session file.
 *
 * Lives under `.claw/sessions/{issueNumber}.json` — the path CHECK 11 reads
 * from. Resolved via {@link resolveSetupPaths} so the layout has one owner.
 *
 * @param cwd          target project working directory
 * @param issueNumber  GitHub issue number the session belongs to
 * @returns absolute path to the session file
 */
export function sessionPath(cwd: string, issueNumber: number): string {
  return join(resolveSetupPaths(cwd).sessionsDir, `${issueNumber}.json`);
}

/**
 * Serialize a {@link SessionFile} as JSON with a trailing newline.
 *
 * Two-space indentation matches `.claw/config.json` — diffs stay clean when
 * a human inspects the file.
 *
 * @param session the session to serialize
 * @returns the exact bytes to write to disk
 */
export function serializeSession(session: SessionFile): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/**
 * Parse a JSON string into a {@link SessionFile}, or return `null` when the
 * payload is malformed.
 *
 * Mirrors the validation in CHECK 11's default reader — any shape that would
 * make CHECK 11 skip the file must also round-trip to `null` here. This keeps
 * the read contract identical on both sides of the file.
 *
 * @param raw raw JSON contents from disk
 * @returns the parsed session, or `null` when the shape does not match
 */
export function parseSession(raw: string): SessionFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const shape = parsed as Partial<SessionFile>;
  if (typeof shape.issueNumber !== "number") return null;
  if (typeof shape.sessionId !== "string") return null;
  if (typeof shape.fixAttempts !== "number") return null;
  return {
    issueNumber: shape.issueNumber,
    sessionId: shape.sessionId,
    fixAttempts: shape.fixAttempts,
  };
}

/**
 * Persist a {@link SessionFile} to `.claw/sessions/{issueNumber}.json`.
 *
 * Creates the `.claw/sessions/` directory if it does not yet exist — `claw
 * setup` creates it on first run, but the loop must not crash on a stray
 * delete between runs.
 *
 * @param cwd     target project working directory
 * @param session the session to save
 * @param fs      optional filesystem seam for testing
 */
export async function saveSession(
  cwd: string,
  session: SessionFile,
  fs: SessionFs = defaultFs,
): Promise<void> {
  const path = sessionPath(cwd, session.issueNumber);
  await fs.writeFile(path, serializeSession(session));
}

/**
 * Load a {@link SessionFile} from disk.
 *
 * Returns `null` when the file is missing or malformed. The fix cycle calls
 * this to recover the Claude session ID — a `null` return means "no session
 * yet" and the caller must fall back to a fresh implementation spawn.
 *
 * @param cwd          target project working directory
 * @param issueNumber  GitHub issue number
 * @param fs           optional filesystem seam for testing
 * @returns the parsed session, or `null` when missing/unreadable
 */
export async function loadSession(
  cwd: string,
  issueNumber: number,
  fs: SessionFs = defaultFs,
): Promise<SessionFile | null> {
  const path = sessionPath(cwd, issueNumber);
  const raw = await fs.readFile(path);
  if (raw === null) return null;
  return parseSession(raw);
}

/**
 * Delete a {@link SessionFile} from disk.
 *
 * No-op when the file does not exist — successful merges and escalations both
 * call this as a cleanup step and neither should care whether a previous run
 * already removed the file.
 *
 * @param cwd          target project working directory
 * @param issueNumber  GitHub issue number
 * @param fs           optional filesystem seam for testing
 */
export async function deleteSession(
  cwd: string,
  issueNumber: number,
  fs: SessionFs = defaultFs,
): Promise<void> {
  const path = sessionPath(cwd, issueNumber);
  await fs.removeFile(path);
}

/** Default filesystem seam — reads/writes through `node:fs/promises`. */
const defaultFs: SessionFs = {
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  },
  removeFile: async (path) => {
    await rm(path, { force: true });
  },
};
