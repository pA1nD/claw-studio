import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ClawError } from "../types/errors.js";

/**
 * One artifact setup writes to disk.
 *
 * Tracked individually so that if step N fails, the rollback tracker knows
 * exactly which paths it created — and only those — without guessing based
 * on the canonical footprint.
 */
export interface WriteArtifact {
  /** Absolute path of the file or directory created. */
  path: string;
  /** Whether the entry is a file (`file`) or an empty directory (`dir`). */
  kind: "file" | "dir";
}

/** Injectable filesystem primitives so the tracker can be unit-tested. */
export interface WriteTrackerFs {
  /** Write `content` to `path`, creating parent directories as needed. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Create `path` as a directory, recursively, no error if it exists. */
  mkdir?: (path: string) => Promise<void>;
  /** Recursively delete `path`, no error if it does not exist. */
  rm?: (path: string) => Promise<void>;
}

/**
 * Tracks every file and directory setup creates so the whole set can be
 * rolled back atomically on failure.
 *
 * Per issue #18: "Does not leave the repo in a partial state — rolls back
 * created files." This tracker is the mechanism.
 */
export class WriteTracker {
  private readonly created: WriteArtifact[] = [];
  private readonly fs: Required<WriteTrackerFs>;

  /**
   * Create a tracker.
   * @param fs optional filesystem dependency injection for tests
   */
  constructor(fs: WriteTrackerFs = {}) {
    this.fs = {
      writeFile: fs.writeFile ?? defaultWriteFile,
      mkdir: fs.mkdir ?? defaultMkdir,
      rm: fs.rm ?? defaultRm,
    };
  }

  /**
   * Write a file, recording the action for potential rollback.
   *
   * @param path absolute path
   * @param content file contents as UTF-8 text
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.fs.mkdir(dirname(path));
    await this.fs.writeFile(path, content);
    this.created.push({ path, kind: "file" });
  }

  /**
   * Create an empty directory, recording the action for potential rollback.
   *
   * @param path absolute path of the directory to create
   */
  async mkdir(path: string): Promise<void> {
    await this.fs.mkdir(path);
    this.created.push({ path, kind: "dir" });
  }

  /**
   * Roll back every file and directory this tracker has created, in reverse
   * order, so nested directories unwind cleanly. Errors during rollback are
   * collected rather than thrown — the caller already has a primary failure
   * to surface, and we do not want rollback noise to replace it.
   *
   * @returns paths that could not be removed, if any
   */
  async rollback(): Promise<string[]> {
    const failures: string[] = [];
    for (let i = this.created.length - 1; i >= 0; i -= 1) {
      const entry = this.created[i];
      if (!entry) continue;
      try {
        await this.fs.rm(entry.path);
      } catch {
        failures.push(entry.path);
      }
    }
    this.created.length = 0;
    return failures;
  }

  /** Snapshot of everything written so far, in insertion order. */
  get artifacts(): readonly WriteArtifact[] {
    return [...this.created];
  }
}

/**
 * Convenience helper that wraps {@link WriteTracker.rollback} into a
 * {@link ClawError} when any path cannot be removed.
 *
 * Called by the orchestrator after a failed write so the human gets both
 * the original failure message AND a pointer at any partial state left
 * behind — never a silent mess.
 *
 * @param tracker the tracker whose artifacts should be removed
 * @throws {ClawError} when rollback itself fails partially
 */
export async function rollbackOrThrow(tracker: WriteTracker): Promise<void> {
  const failures = await tracker.rollback();
  if (failures.length > 0) {
    throw new ClawError(
      "setup failed and rollback could not remove every partial file.",
      `Manually delete: ${failures.join(", ")}`,
    );
  }
}

/** Default: `fs.writeFile(path, content, "utf8")`. */
async function defaultWriteFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

/** Default: `fs.mkdir(path, { recursive: true })`. */
async function defaultMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/** Default: `fs.rm(path, { recursive: true, force: true })`. */
async function defaultRm(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
