import { describe, it, expect, vi } from "vitest";
import {
  CLAUDE_MD_PROMPT,
  buildPrompt,
  generateClaudeMd,
} from "../../../src/core/setup/claude-md.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("buildPrompt", () => {
  it("includes the canonical prompt prefix", () => {
    const prompt = buildPrompt("readme body", "roadmap body");
    expect(prompt.startsWith(CLAUDE_MD_PROMPT)).toBe(true);
  });

  it("includes both source documents, clearly delimited", () => {
    const prompt = buildPrompt("the readme", "the roadmap");
    expect(prompt).toContain("--- BEGIN README.md ---");
    expect(prompt).toContain("the readme");
    expect(prompt).toContain("--- END README.md ---");
    expect(prompt).toContain("--- BEGIN ROADMAP.md ---");
    expect(prompt).toContain("the roadmap");
    expect(prompt).toContain("--- END ROADMAP.md ---");
  });
});

describe("generateClaudeMd", () => {
  it("reads README and ROADMAP, passes them to the generator, returns the result with a trailing newline", async () => {
    const runGenerator = vi.fn(async (prompt: string) => {
      // The generator sees both documents inlined in the prompt.
      expect(prompt).toContain("hello readme");
      expect(prompt).toContain("hello roadmap");
      return "# CLAUDE.md\nBe specific.";
    });

    const result = await generateClaudeMd({
      cwd: "/tmp/project",
      deps: {
        readFile: async (path: string) => {
          if (path.endsWith("README.md")) return "hello readme";
          if (path.endsWith("ROADMAP.md")) return "hello roadmap";
          throw new Error(`unexpected read: ${path}`);
        },
        runGenerator,
      },
    });

    expect(result).toBe("# CLAUDE.md\nBe specific.\n");
    expect(runGenerator).toHaveBeenCalledTimes(1);
  });

  it("throws ClawError when the generator returns empty output", async () => {
    const error = await generateClaudeMd({
      cwd: "/tmp/project",
      deps: {
        readFile: async () => "source",
        runGenerator: async () => "   \n   ",
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("empty output");
  });

  it("surfaces a friendly ClawError when README cannot be read", async () => {
    const error = await generateClaudeMd({
      cwd: "/tmp/project",
      deps: {
        readFile: async (path: string) => {
          if (path.endsWith("README.md")) {
            throw new Error("ENOENT");
          }
          return "roadmap";
        },
        runGenerator: async () => "CLAUDE",
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("README.md");
  });

  it("surfaces a friendly ClawError when ROADMAP cannot be read", async () => {
    const error = await generateClaudeMd({
      cwd: "/tmp/project",
      deps: {
        readFile: async (path: string) => {
          if (path.endsWith("ROADMAP.md")) {
            throw new Error("ENOENT");
          }
          return "readme";
        },
        runGenerator: async () => "CLAUDE",
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("ROADMAP.md");
  });

  it("trims generator output before appending the single trailing newline", async () => {
    const result = await generateClaudeMd({
      cwd: "/tmp/project",
      deps: {
        readFile: async () => "src",
        runGenerator: async () => "\n\n# CLAUDE\n\n\n",
      },
    });
    expect(result).toBe("# CLAUDE\n");
  });
});
