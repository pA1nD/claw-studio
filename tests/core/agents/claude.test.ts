import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLAUDE_TIMEOUT_MS,
  isCommandNotFound,
  isTimeout,
  mapClaudeSubprocessError,
  parseClaudeOutput,
  resumeImplementationSession,
  spawnImplementationSession,
} from "../../../src/core/agents/claude.js";
import type {
  ClaudeInvocation,
  ClaudeResult,
} from "../../../src/core/agents/claude.js";
import { ClawError } from "../../../src/core/types/errors.js";

describe("parseClaudeOutput", () => {
  it("parses the `{ session_id, result }` payload Claude emits", () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({ session_id: "abc", result: "implemented" }),
    );
    expect(parsed).toEqual({ sessionId: "abc", resultText: "implemented" });
  });

  it("coerces a missing `result` to an empty string", () => {
    const parsed = parseClaudeOutput(JSON.stringify({ session_id: "abc" }));
    expect(parsed).toEqual({ sessionId: "abc", resultText: "" });
  });

  it("throws ClawError on invalid JSON", () => {
    expect(() => parseClaudeOutput("not json")).toThrow(ClawError);
  });

  it("throws ClawError when `session_id` is missing", () => {
    expect(() =>
      parseClaudeOutput(JSON.stringify({ result: "no session" })),
    ).toThrow(ClawError);
  });

  it("throws ClawError when `session_id` is the wrong type", () => {
    expect(() =>
      parseClaudeOutput(JSON.stringify({ session_id: 42, result: "r" })),
    ).toThrow(ClawError);
  });

  it("throws ClawError when the payload is not an object", () => {
    expect(() => parseClaudeOutput("42")).toThrow(ClawError);
    expect(() => parseClaudeOutput("null")).toThrow(ClawError);
  });

  it("throws ClawError when `session_id` is an empty string", () => {
    expect(() =>
      parseClaudeOutput(JSON.stringify({ session_id: "", result: "x" })),
    ).toThrow(ClawError);
  });
});

describe("isCommandNotFound", () => {
  it("matches execa ENOENT by `code`", () => {
    expect(isCommandNotFound({ code: "ENOENT" })).toBe(true);
  });

  it("matches execa ENOENT by `errno`", () => {
    expect(isCommandNotFound({ errno: -2 })).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isCommandNotFound({ code: "EPERM" })).toBe(false);
    expect(isCommandNotFound(new Error("nope"))).toBe(false);
    expect(isCommandNotFound(null)).toBe(false);
    expect(isCommandNotFound("string")).toBe(false);
  });
});

describe("isTimeout", () => {
  it("matches an execa timed-out error", () => {
    expect(isTimeout({ timedOut: true })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTimeout({ timedOut: false })).toBe(false);
    expect(isTimeout({})).toBe(false);
    expect(isTimeout(null)).toBe(false);
    expect(isTimeout(new Error("boom"))).toBe(false);
  });
});

describe("mapClaudeSubprocessError", () => {
  it("maps ENOENT to a `claude CLI not found` error", () => {
    const err = mapClaudeSubprocessError({ code: "ENOENT" }, 60_000);
    expect(err).toBeInstanceOf(ClawError);
    expect(err.message).toContain("`claude` CLI not found on PATH");
    expect(err.hint).toContain("Install Claude Code");
  });

  it("maps timedOut to a timeout error with the configured timeout seconds", () => {
    const err = mapClaudeSubprocessError({ timedOut: true }, 5_000);
    expect(err).toBeInstanceOf(ClawError);
    expect(err.message).toContain("did not respond in time");
    expect(err.hint).toContain("killed after 5s");
  });

  it("falls back to a generic ClawError for any other subprocess failure", () => {
    const err = mapClaudeSubprocessError(new Error("exit 1"), 60_000);
    expect(err).toBeInstanceOf(ClawError);
    expect(err.message).toBe("`claude -p` failed.");
    expect(err.hint).toContain("exit 1");
  });

  it("prefers `shortMessage` over `message` to avoid leaking subprocess stderr", () => {
    // execa v8 exposes `shortMessage` — just the command and exit code, no
    // stderr. Using it protects against accidentally forwarding credential-
    // bearing diagnostics into the ClawError hint.
    const execaLike = {
      shortMessage: "Command failed with exit code 1: claude -p",
      message:
        "Command failed with exit code 1: claude -p\nERROR: invalid token: ghp_SECRETVALUE",
    };
    const err = mapClaudeSubprocessError(execaLike, 60_000);
    expect(err.hint).toContain("Command failed with exit code 1: claude -p");
    expect(err.hint).not.toContain("ghp_SECRETVALUE");
  });

  it("handles non-Error throwables via String(...)", () => {
    const err = mapClaudeSubprocessError("raw string", 60_000);
    expect(err).toBeInstanceOf(ClawError);
    expect(err.hint).toContain("raw string");
  });
});

describe("spawnImplementationSession", () => {
  it("invokes `claude -p --system-prompt <path> --output-format json`", async () => {
    const invocations: ClaudeInvocation[] = [];
    const runClaude = vi.fn(async (inv: ClaudeInvocation): Promise<ClaudeResult> => {
      invocations.push(inv);
      return { sessionId: "new-session", resultText: "done" };
    });

    const result = await spawnImplementationSession({
      systemPromptPath: "/tmp/.claw/CLAUDE.md",
      prompt: "the full context prompt",
      cwd: "/tmp/repo",
      deps: { runClaude },
    });

    expect(result).toEqual({ sessionId: "new-session", resultText: "done" });
    expect(invocations).toHaveLength(1);
    const inv = invocations[0];
    expect(inv?.args).toEqual([
      "-p",
      "--system-prompt",
      "/tmp/.claw/CLAUDE.md",
      "--output-format",
      "json",
    ]);
    expect(inv?.stdin).toBe("the full context prompt");
    expect(inv?.cwd).toBe("/tmp/repo");
    expect(inv?.timeoutMs).toBe(DEFAULT_CLAUDE_TIMEOUT_MS);
  });

  it("respects an explicit timeout override", async () => {
    const runClaude = vi.fn(async () => ({ sessionId: "s", resultText: "" }));
    await spawnImplementationSession({
      systemPromptPath: "/p",
      prompt: "p",
      cwd: "/cwd",
      timeoutMs: 1234,
      deps: { runClaude },
    });
    expect(runClaude.mock.calls[0]?.[0].timeoutMs).toBe(1234);
  });
});

describe("resumeImplementationSession", () => {
  it("invokes `claude -p --resume <sessionId> --output-format json`", async () => {
    const runClaude = vi.fn(async (): Promise<ClaudeResult> => ({
      sessionId: "sid-after",
      resultText: "fix applied",
    }));

    await resumeImplementationSession({
      sessionId: "sid-before",
      prompt: "fix this",
      cwd: "/tmp/repo",
      deps: { runClaude },
    });

    const inv = runClaude.mock.calls[0]?.[0];
    expect(inv?.args).toEqual([
      "-p",
      "--resume",
      "sid-before",
      "--output-format",
      "json",
    ]);
    expect(inv?.stdin).toBe("fix this");
  });

  it("returns whatever sessionId Claude reports (which may differ on fork)", async () => {
    const runClaude = vi.fn(async () => ({
      sessionId: "forked-sid",
      resultText: "",
    }));
    const result = await resumeImplementationSession({
      sessionId: "original-sid",
      prompt: "p",
      cwd: "/cwd",
      deps: { runClaude },
    });
    expect(result.sessionId).toBe("forked-sid");
  });
});
