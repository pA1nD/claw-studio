import { describe, it, expect } from "vitest";
import { buildProgram, parseLogEntryCount } from "../../src/cli/index.js";
import { ClawError } from "../../src/core/types/errors.js";

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

  it("declares --repo and --overwrite on setup", () => {
    const program = buildProgram();
    const setup = program.commands.find((command) => command.name() === "setup");
    expect(setup).toBeDefined();
    const flags = (setup?.options ?? []).map((option) => option.long);
    expect(flags).toContain("--repo");
    expect(flags).toContain("--overwrite");
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
