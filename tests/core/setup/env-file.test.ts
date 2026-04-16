import { describe, it, expect, vi } from "vitest";
import {
  mergeEnvFile,
  parseEnvFile,
  readEnvFile,
  serializeEnvFile,
  writeEnvFile,
} from "../../../src/core/setup/env-file.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("parseEnvFile", () => {
  it("extracts GITHUB_PAT and CLAUDE_CODE_OAUTH_TOKEN", () => {
    const parsed = parseEnvFile(
      "GITHUB_PAT=ghp_abc\nCLAUDE_CODE_OAUTH_TOKEN=clm_xyz\n",
    );
    expect(parsed.GITHUB_PAT).toBe("ghp_abc");
    expect(parsed.CLAUDE_CODE_OAUTH_TOKEN).toBe("clm_xyz");
  });

  it("preserves unrecognised keys in raw", () => {
    const parsed = parseEnvFile("CUSTOM=abc\nGITHUB_PAT=ghp_test\n");
    expect(parsed.raw.get("CUSTOM")).toBe("abc");
    expect(parsed.raw.get("GITHUB_PAT")).toBe("ghp_test");
  });

  it("ignores blank lines and comments", () => {
    const parsed = parseEnvFile("# a comment\n\nGITHUB_PAT=ok\n# also skip\n");
    expect(parsed.GITHUB_PAT).toBe("ok");
    expect(parsed.raw.size).toBe(1);
  });

  it("strips surrounding double quotes from values", () => {
    const parsed = parseEnvFile('GITHUB_PAT="ghp_quoted"\n');
    expect(parsed.GITHUB_PAT).toBe("ghp_quoted");
  });

  it("strips surrounding single quotes from values", () => {
    const parsed = parseEnvFile("GITHUB_PAT='ghp_single'\n");
    expect(parsed.GITHUB_PAT).toBe("ghp_single");
  });

  it("does not strip mismatched quotes", () => {
    const parsed = parseEnvFile('GITHUB_PAT="mis\'\n');
    expect(parsed.GITHUB_PAT).toBe("\"mis'");
  });

  it("throws ClawError on a line missing `=` and names the line number", () => {
    let caught: unknown;
    try {
      parseEnvFile("GITHUB_PAT=ok\nno_equals_sign_here\n");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    // The 2nd line is the offender — the error must say so.
    expect((caught as ClawError).message).toContain("line 2");
  });

  it("throws ClawError when the line starts with `=` and names the line number", () => {
    let caught: unknown;
    try {
      parseEnvFile("=value\n");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    expect((caught as ClawError).message).toContain("line 1");
  });

  it("leaves GITHUB_PAT undefined when the file has only unknown keys", () => {
    const parsed = parseEnvFile("OTHER=value\n");
    expect(parsed.GITHUB_PAT).toBeUndefined();
  });
});

describe("serializeEnvFile", () => {
  it("emits GITHUB_PAT and CLAUDE_CODE_OAUTH_TOKEN first", () => {
    const out = serializeEnvFile({
      GITHUB_PAT: "ghp_1",
      CLAUDE_CODE_OAUTH_TOKEN: "clm_1",
      raw: new Map([["CUSTOM", "later"]]),
    });
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("GITHUB_PAT=ghp_1");
    expect(lines[1]).toBe("CLAUDE_CODE_OAUTH_TOKEN=clm_1");
    expect(lines[2]).toBe("CUSTOM=later");
  });

  it("is round-trip safe with parseEnvFile", () => {
    const original = {
      GITHUB_PAT: "a",
      CLAUDE_CODE_OAUTH_TOKEN: "b",
      raw: new Map([
        ["CUSTOM", "c"],
        ["GITHUB_PAT", "a"],
        ["CLAUDE_CODE_OAUTH_TOKEN", "b"],
      ]),
    };
    const serialized = serializeEnvFile(original);
    const parsed = parseEnvFile(serialized);
    expect(parsed.GITHUB_PAT).toBe("a");
    expect(parsed.CLAUDE_CODE_OAUTH_TOKEN).toBe("b");
    expect(parsed.raw.get("CUSTOM")).toBe("c");
  });

  it("omits undefined/empty tokens", () => {
    const out = serializeEnvFile({ raw: new Map() });
    expect(out).toBe("\n");
  });
});

describe("readEnvFile", () => {
  it("returns an empty EnvFile when the file is missing", async () => {
    const env = await readEnvFile("/tmp/nope", {
      readFile: async () => null,
    });
    expect(env.GITHUB_PAT).toBeUndefined();
    expect(env.raw.size).toBe(0);
  });

  it("parses the file when it exists", async () => {
    const env = await readEnvFile("/tmp/exists", {
      readFile: async () => "GITHUB_PAT=ghp_real\n",
    });
    expect(env.GITHUB_PAT).toBe("ghp_real");
  });

  it("propagates malformed content as a ClawError through the reader", async () => {
    // The seam is the reader, so a parse error from the underlying file
    // surfaces to the caller — no silent `null` return that would mask a
    // real problem in .claw/.env.
    await expect(
      readEnvFile("/tmp/malformed", {
        readFile: async () => "no_equals_line\n",
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });
});

describe("writeEnvFile", () => {
  it("creates parent dirs, writes the file, and chmods to 0600", async () => {
    const writes = new Map<string, string>();
    const mkdirs: string[] = [];
    const chmods: Array<{ path: string; mode: number }> = [];
    await writeEnvFile(
      "/tmp/proj/.claw/.env",
      { GITHUB_PAT: "ghp_test", raw: new Map() },
      {
        writeFile: async (path, content) => {
          writes.set(path, content);
        },
        mkdir: async (path) => {
          mkdirs.push(path);
        },
        chmod: async (path, mode) => {
          chmods.push({ path, mode });
        },
      },
    );
    expect(writes.get("/tmp/proj/.claw/.env")).toContain("GITHUB_PAT=ghp_test");
    expect(mkdirs).toContain("/tmp/proj/.claw");
    expect(chmods).toEqual([{ path: "/tmp/proj/.claw/.env", mode: 0o600 }]);
  });

  it("tolerates chmod failure (Windows FAT compatibility)", async () => {
    const writes = new Map<string, string>();
    const chmodFailing = vi.fn(async () => {
      throw new Error("ENOSYS");
    });
    await expect(
      writeEnvFile(
        "/tmp/x/.claw/.env",
        { GITHUB_PAT: "y", raw: new Map() },
        {
          writeFile: async (path, content) => {
            writes.set(path, content);
          },
          mkdir: async () => {},
          chmod: chmodFailing,
        },
      ),
    ).resolves.toBeUndefined();
    expect(chmodFailing).toHaveBeenCalled();
    expect(writes.size).toBe(1);
  });
});

describe("mergeEnvFile", () => {
  it("uses updates when present", () => {
    const merged = mergeEnvFile(
      { GITHUB_PAT: "old", raw: new Map([["GITHUB_PAT", "old"]]) },
      { GITHUB_PAT: "new" },
    );
    expect(merged.GITHUB_PAT).toBe("new");
    expect(merged.raw.get("GITHUB_PAT")).toBe("new");
  });

  it("keeps base values when updates are undefined", () => {
    const merged = mergeEnvFile(
      { GITHUB_PAT: "keep", raw: new Map([["GITHUB_PAT", "keep"]]) },
      {},
    );
    expect(merged.GITHUB_PAT).toBe("keep");
  });

  it("keeps base values when updates are empty strings", () => {
    const merged = mergeEnvFile(
      { GITHUB_PAT: "keep", raw: new Map([["GITHUB_PAT", "keep"]]) },
      { GITHUB_PAT: "" },
    );
    expect(merged.GITHUB_PAT).toBe("keep");
  });

  it("preserves unknown raw keys", () => {
    const merged = mergeEnvFile(
      { raw: new Map([["OTHER", "user-added"]]) },
      { GITHUB_PAT: "new" },
    );
    expect(merged.raw.get("OTHER")).toBe("user-added");
    expect(merged.GITHUB_PAT).toBe("new");
  });
});
