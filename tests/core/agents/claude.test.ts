import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLAUDE_TIMEOUT_MS,
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
