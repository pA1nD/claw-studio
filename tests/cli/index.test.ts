import { describe, it, expect, vi } from "vitest";
import type { Command } from "commander";
import {
  buildProgram,
  parseLogEntryCount,
  parseRunnerCount,
} from "../../src/cli/index.js";
import { ClawError } from "../../src/core/types/errors.js";

/**
 * Build a fresh program with every action replaced by a spy that
 * records the options object Commander parsed. Returns a lookup by
 * command name so each test can assert the exact options a specific
 * command received.
 */
function spiedProgram(): {
  program: Command;
  captured: Map<string, Record<string, unknown>>;
} {
  const program = buildProgram();
  const captured = new Map<string, Record<string, unknown>>();

  // Suppress Commander's process.exit on --help / --version and error.
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });

  for (const cmd of program.commands) {
    const name = cmd.name();
    cmd.action(async (opts: Record<string, unknown>) => {
      captured.set(name, opts);
    });
  }

  // Replace the root action too (bare `claw` with no sub-command).
  program.action(async () => {
    captured.set("root", {});
  });

  return { program, captured };
}

/** Parse argv through a spied program and return the captured options. */
async function parseFlags(
  argv: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const { program, captured } = spiedProgram();
  await program.parseAsync(["node", "claw", ...argv]);
  return captured;
}

describe("buildProgram", () => {
  // Note: `help` is added lazily by Commander when the program parses
  // arguments, so it is not visible on `program.commands` at build time.
  // It is validated separately via `helpInformation()` below.
  const expected = [
    "setup",
    "start",
    "status",
    "pause",
    "resume",
    "stop",
    "logs",
  ] as const;

  it("registers every explicit v0.0.1 sub-command", () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name());
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("exposes `help [command]` through the rendered help output", () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain("help [command]");
  });

  it("exposes the expected top-level name and version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("claw");
    expect(program.version()).toBe("0.0.1");
  });

  it("declares every v0.1 flag on setup", () => {
    const program = buildProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup).toBeDefined();
    const flags = (setup?.options ?? []).map((option) => option.long);
    expect(flags).toContain("--repo");
    expect(flags).toContain("--overwrite");
    expect(flags).toContain("--yes");
    expect(flags).toContain("--skip-runners");
    expect(flags).toContain("--runner-count");
    expect(flags).toContain("--github-pat");
    expect(flags).toContain("--claude-token");
  });

  it("declares --tail and --n on logs", () => {
    const program = buildProgram();
    const logs = program.commands.find((command) => command.name() === "logs");
    expect(logs).toBeDefined();
    const flags = (logs?.options ?? []).map((option) => option.long);
    expect(flags).toContain("--tail");
    expect(flags).toContain("--n");
  });
});

describe("parseLogEntryCount", () => {
  it("parses positive integers", () => {
    expect(parseLogEntryCount("20")).toBe(20);
  });

  it("accepts zero as valid", () => {
    expect(parseLogEntryCount("0")).toBe(0);
  });

  it("throws ClawError on non-numeric input", () => {
    expect(() => parseLogEntryCount("abc")).toThrow(ClawError);
  });

  it("throws ClawError on a negative value", () => {
    expect(() => parseLogEntryCount("-1")).toThrow(ClawError);
  });

  it("throws ClawError on an empty string", () => {
    expect(() => parseLogEntryCount("")).toThrow(ClawError);
  });

  it("does not echo the raw input in the error message (credential safety)", () => {
    // A user who mistypes --n and passes a secret must not see it in the terminal.
    let caught: unknown;
    try {
      parseLogEntryCount("ghp_not_a_real_token_but_pretend");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    const message = (caught as ClawError).message;
    expect(message).not.toContain("ghp_");
  });
});

// ── Flag parsing integration tests ────────────────────────────────────
// These verify that Commander correctly parses each flag and delivers
// the right value to the command's action handler. They catch:
//   - typos in flag names
//   - missing coercion functions
//   - boolean flags defaulting wrong
//   - camelCase option name mismatches

describe("claw setup flags", () => {
  it("parses --repo into options.repo", async () => {
    const map = await parseFlags(["setup", "--repo", "pA1nD/test"]);
    expect(map.get("setup")?.repo).toBe("pA1nD/test");
  });

  it("--overwrite defaults to false", async () => {
    const map = await parseFlags(["setup"]);
    expect(map.get("setup")?.overwrite).toBe(false);
  });

  it("--overwrite flag sets true", async () => {
    const map = await parseFlags(["setup", "--overwrite"]);
    expect(map.get("setup")?.overwrite).toBe(true);
  });

  it("-y is an alias for --yes", async () => {
    const map = await parseFlags(["setup", "-y"]);
    expect(map.get("setup")?.yes).toBe(true);
  });

  it("--yes defaults to false", async () => {
    const map = await parseFlags(["setup"]);
    expect(map.get("setup")?.yes).toBe(false);
  });

  it("--skip-runners defaults to false", async () => {
    const map = await parseFlags(["setup"]);
    expect(map.get("setup")?.skipRunners).toBe(false);
  });

  it("--skip-runners flag sets true", async () => {
    const map = await parseFlags(["setup", "--skip-runners"]);
    expect(map.get("setup")?.skipRunners).toBe(true);
  });

  it("--runner-count parses a positive integer", async () => {
    const map = await parseFlags(["setup", "--runner-count", "12"]);
    expect(map.get("setup")?.runnerCount).toBe(12);
  });

  it("--runner-count rejects zero", async () => {
    await expect(parseFlags(["setup", "--runner-count", "0"])).rejects.toThrow();
  });

  it("--runner-count rejects non-numeric input", async () => {
    await expect(parseFlags(["setup", "--runner-count", "six"])).rejects.toThrow();
  });

  it("--github-pat forwards the value as githubPat", async () => {
    const map = await parseFlags(["setup", "--github-pat", "ghp_test123"]);
    expect(map.get("setup")?.githubPat).toBe("ghp_test123");
  });

  it("--claude-token forwards the value as claudeToken", async () => {
    const map = await parseFlags(["setup", "--claude-token", "clm_abc"]);
    expect(map.get("setup")?.claudeToken).toBe("clm_abc");
  });

  it("every flag at once", async () => {
    const map = await parseFlags([
      "setup",
      "--repo", "owner/repo",
      "--overwrite",
      "--yes",
      "--skip-runners",
      "--runner-count", "8",
      "--github-pat", "ghp_x",
      "--claude-token", "clm_y",
    ]);
    const opts = map.get("setup");
    expect(opts).toEqual({
      repo: "owner/repo",
      overwrite: true,
      yes: true,
      skipRunners: true,
      runnerCount: 8,
      githubPat: "ghp_x",
      claudeToken: "clm_y",
    });
  });
});

describe("claw start flags", () => {
  it("parses --repo", async () => {
    const map = await parseFlags(["start", "--repo", "pA1nD/test"]);
    expect(map.get("start")?.repo).toBe("pA1nD/test");
  });

  it("--auto-continue defaults to false", async () => {
    const map = await parseFlags(["start"]);
    expect(map.get("start")?.autoContinue).toBe(false);
  });

  it("--auto-continue flag sets true", async () => {
    const map = await parseFlags(["start", "--auto-continue"]);
    expect(map.get("start")?.autoContinue).toBe(true);
  });

  it("--dry-run defaults to false", async () => {
    const map = await parseFlags(["start"]);
    expect(map.get("start")?.dryRun).toBe(false);
  });

  it("--dry-run flag sets true", async () => {
    const map = await parseFlags(["start", "--dry-run"]);
    expect(map.get("start")?.dryRun).toBe(true);
  });

  it("all start flags at once", async () => {
    const map = await parseFlags([
      "start",
      "--repo", "a/b",
      "--auto-continue",
      "--dry-run",
    ]);
    expect(map.get("start")).toEqual({
      repo: "a/b",
      autoContinue: true,
      dryRun: true,
    });
  });
});

describe("claw status flags", () => {
  it("parses --repo", async () => {
    const map = await parseFlags(["status", "--repo", "a/b"]);
    expect(map.get("status")?.repo).toBe("a/b");
  });

  it("--repo is optional (defaults to undefined)", async () => {
    const map = await parseFlags(["status"]);
    expect(map.get("status")?.repo).toBeUndefined();
  });
});

describe("claw pause flags", () => {
  it("has no options", async () => {
    const map = await parseFlags(["pause"]);
    expect(map.has("pause")).toBe(true);
  });
});

describe("claw resume flags", () => {
  it("has no options", async () => {
    const map = await parseFlags(["resume"]);
    expect(map.has("resume")).toBe(true);
  });
});

describe("claw stop flags", () => {
  it("has no options", async () => {
    const map = await parseFlags(["stop"]);
    expect(map.has("stop")).toBe(true);
  });
});

describe("claw logs flags", () => {
  it("--tail defaults to false", async () => {
    const map = await parseFlags(["logs"]);
    expect(map.get("logs")?.tail).toBe(false);
  });

  it("--tail flag sets true", async () => {
    const map = await parseFlags(["logs", "--tail"]);
    expect(map.get("logs")?.tail).toBe(true);
  });

  it("--n parses a positive integer", async () => {
    const map = await parseFlags(["logs", "--n", "50"]);
    expect(map.get("logs")?.n).toBe(50);
  });

  it("--n accepts zero", async () => {
    const map = await parseFlags(["logs", "--n", "0"]);
    expect(map.get("logs")?.n).toBe(0);
  });

  it("--n rejects negative values", async () => {
    await expect(parseFlags(["logs", "--n", "-5"])).rejects.toThrow();
  });

  it("--n rejects non-numeric input", async () => {
    await expect(parseFlags(["logs", "--n", "abc"])).rejects.toThrow();
  });

  it("all logs flags at once", async () => {
    const map = await parseFlags(["logs", "--tail", "--n", "100"]);
    expect(map.get("logs")).toEqual({ tail: true, n: 100 });
  });
});

describe("claw --version / --help (top-level)", () => {
  it("--version exits with code 0", async () => {
    const { program } = spiedProgram();
    let exitCode: number | undefined;
    try {
      await program.parseAsync(["node", "claw", "--version"]);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "exitCode" in err) {
        exitCode = (err as { exitCode: number }).exitCode;
      }
    }
    expect(exitCode).toBe(0);
  });

  it("-v is an alias for --version", async () => {
    const { program } = spiedProgram();
    let exitCode: number | undefined;
    try {
      await program.parseAsync(["node", "claw", "-v"]);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "exitCode" in err) {
        exitCode = (err as { exitCode: number }).exitCode;
      }
    }
    expect(exitCode).toBe(0);
  });

  it("--help exits with code 0", async () => {
    const { program } = spiedProgram();
    let exitCode: number | undefined;
    try {
      await program.parseAsync(["node", "claw", "--help"]);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "exitCode" in err) {
        exitCode = (err as { exitCode: number }).exitCode;
      }
    }
    expect(exitCode).toBe(0);
  });

  it("-h is an alias for --help", async () => {
    const { program } = spiedProgram();
    let exitCode: number | undefined;
    try {
      await program.parseAsync(["node", "claw", "-h"]);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "exitCode" in err) {
        exitCode = (err as { exitCode: number }).exitCode;
      }
    }
    expect(exitCode).toBe(0);
  });

  it("unknown flag errors", async () => {
    await expect(parseFlags(["--does-not-exist"])).rejects.toThrow();
  });
});

describe("parseRunnerCount", () => {
  it("parses positive integers", () => {
    expect(parseRunnerCount("6")).toBe(6);
    expect(parseRunnerCount("12")).toBe(12);
  });

  it("throws ClawError on zero (runners must be at least 1)", () => {
    expect(() => parseRunnerCount("0")).toThrow(ClawError);
  });

  it("throws ClawError on negative integers", () => {
    expect(() => parseRunnerCount("-2")).toThrow(ClawError);
  });

  it("throws ClawError on non-numeric input", () => {
    expect(() => parseRunnerCount("six")).toThrow(ClawError);
  });

  it("does not echo the raw input in the error (credential safety)", () => {
    let caught: unknown;
    try {
      parseRunnerCount("ghp_leaky");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawError);
    const message = (caught as ClawError).message;
    expect(message).not.toContain("ghp_");
  });
});
