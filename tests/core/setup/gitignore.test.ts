import { describe, it, expect, vi } from "vitest";
import {
  CLAW_GITIGNORE_ENTRY,
  ensureClawIsGitignored,
  gitignoreAlreadyCoversClaw,
} from "../../../src/core/setup/gitignore.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("gitignoreAlreadyCoversClaw", () => {
  it("matches `.claw/` on its own line", () => {
    expect(gitignoreAlreadyCoversClaw(".claw/\n")).toBe(true);
    expect(gitignoreAlreadyCoversClaw("node_modules\n.claw/\n")).toBe(true);
  });

  it("matches `.claw` without trailing slash", () => {
    expect(gitignoreAlreadyCoversClaw(".claw\n")).toBe(true);
  });

  it("matches `/.claw` and `/.claw/`", () => {
    expect(gitignoreAlreadyCoversClaw("/.claw\n")).toBe(true);
    expect(gitignoreAlreadyCoversClaw("/.claw/\n")).toBe(true);
  });

  it("ignores comment lines that mention .claw/", () => {
    expect(gitignoreAlreadyCoversClaw("# .claw/ is ignored elsewhere\n")).toBe(
      false,
    );
  });

  it("returns false when `.claw/` is absent", () => {
    expect(gitignoreAlreadyCoversClaw("node_modules\ndist\n")).toBe(false);
  });

  it("tolerates leading whitespace and trailing comments", () => {
    expect(gitignoreAlreadyCoversClaw("  .claw/  # generated\n")).toBe(true);
  });
});

describe("ensureClawIsGitignored", () => {
  it("creates a new .gitignore when the file is missing", async () => {
    const writes = new Map<string, string>();
    const updated = await ensureClawIsGitignored("/tmp/p/.gitignore", {
      readFile: async () => null,
      writeFile: async (path, content) => {
        writes.set(path, content);
      },
    });
    expect(updated).toBe(true);
    expect(writes.get("/tmp/p/.gitignore")).toBe(`${CLAW_GITIGNORE_ENTRY}\n`);
  });

  it("appends `.claw/` to an existing file that does not cover it", async () => {
    const writes = new Map<string, string>();
    const updated = await ensureClawIsGitignored("/tmp/p/.gitignore", {
      readFile: async () => "node_modules\ndist\n",
      writeFile: async (path, content) => {
        writes.set(path, content);
      },
    });
    expect(updated).toBe(true);
    const content = writes.get("/tmp/p/.gitignore") ?? "";
    expect(content).toContain("node_modules");
    expect(content).toContain(CLAW_GITIGNORE_ENTRY);
  });

  it("is idempotent when .claw/ is already covered", async () => {
    const writeFile = vi.fn(async () => {});
    const updated = await ensureClawIsGitignored("/tmp/p/.gitignore", {
      readFile: async () => ".claw/\n",
      writeFile,
    });
    expect(updated).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("adds a newline separator when the file does not end with one", async () => {
    const writes = new Map<string, string>();
    await ensureClawIsGitignored("/tmp/p/.gitignore", {
      readFile: async () => "dist",
      writeFile: async (path, content) => {
        writes.set(path, content);
      },
    });
    const content = writes.get("/tmp/p/.gitignore") ?? "";
    // Must terminate with a newline before (and after) the new entry so
    // git reads both the existing pattern and the new one correctly.
    expect(content).toMatch(/dist\n\n\.claw\/\n/);
  });

  it("surfaces read errors as ClawError", async () => {
    await expect(
      ensureClawIsGitignored("/tmp/p/.gitignore", {
        readFile: async () => {
          throw new Error("EACCES");
        },
        writeFile: async () => {},
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });

  it("surfaces write errors as ClawError", async () => {
    await expect(
      ensureClawIsGitignored("/tmp/p/.gitignore", {
        readFile: async () => "existing\n",
        writeFile: async () => {
          throw new Error("EROFS");
        },
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });
});
