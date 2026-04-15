import { describe, expect, it } from "vitest";
import {
  deleteSession,
  loadSession,
  parseSession,
  saveSession,
  serializeSession,
  sessionPath,
} from "../../../src/core/agents/session.js";
import type {
  SessionFile,
  SessionFs,
} from "../../../src/core/agents/session.js";

const CWD = "/tmp/claw-target";

function memoryFs(initial: Record<string, string> = {}): {
  fs: SessionFs;
  reads: string[];
  writes: Record<string, string>;
  removes: string[];
} {
  const writes = { ...initial };
  const reads: string[] = [];
  const removes: string[] = [];
  return {
    writes,
    reads,
    removes,
    fs: {
      readFile: async (path) => {
        reads.push(path);
        return Object.prototype.hasOwnProperty.call(writes, path)
          ? writes[path] ?? null
          : null;
      },
      writeFile: async (path, contents) => {
        writes[path] = contents;
      },
      removeFile: async (path) => {
        removes.push(path);
        delete writes[path];
      },
    },
  };
}

describe("sessionPath", () => {
  it("resolves under the canonical .claw/sessions/ directory", () => {
    expect(sessionPath(CWD, 42)).toBe(`${CWD}/.claw/sessions/42.json`);
  });
});

describe("serializeSession", () => {
  it("emits pretty-printed JSON with a trailing newline", () => {
    const raw = serializeSession({
      issueNumber: 3,
      sessionId: "abc",
      fixAttempts: 1,
    });
    expect(raw).toBe(
      `{\n  "issueNumber": 3,\n  "sessionId": "abc",\n  "fixAttempts": 1\n}\n`,
    );
  });
});

describe("parseSession", () => {
  it("round-trips a valid session", () => {
    const input: SessionFile = { issueNumber: 7, sessionId: "s", fixAttempts: 2 };
    expect(parseSession(serializeSession(input))).toEqual(input);
  });

  it("returns null for invalid JSON", () => {
    expect(parseSession("not json")).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(parseSession("42")).toBeNull();
    expect(parseSession("null")).toBeNull();
  });

  it("returns null when issueNumber is missing or non-numeric", () => {
    expect(parseSession(`{"sessionId":"s","fixAttempts":0}`)).toBeNull();
    expect(
      parseSession(`{"issueNumber":"3","sessionId":"s","fixAttempts":0}`),
    ).toBeNull();
  });

  it("returns null when sessionId is missing or non-string", () => {
    expect(parseSession(`{"issueNumber":1,"fixAttempts":0}`)).toBeNull();
    expect(
      parseSession(`{"issueNumber":1,"sessionId":42,"fixAttempts":0}`),
    ).toBeNull();
  });

  it("returns null when fixAttempts is missing or non-numeric", () => {
    expect(parseSession(`{"issueNumber":1,"sessionId":"s"}`)).toBeNull();
    expect(
      parseSession(`{"issueNumber":1,"sessionId":"s","fixAttempts":"0"}`),
    ).toBeNull();
  });

  it("drops unknown extra fields", () => {
    const parsed = parseSession(
      `{"issueNumber":1,"sessionId":"s","fixAttempts":0,"extra":"x"}`,
    );
    expect(parsed).toEqual({ issueNumber: 1, sessionId: "s", fixAttempts: 0 });
    expect(parsed).not.toHaveProperty("extra");
  });
});

describe("saveSession", () => {
  it("writes the session JSON under .claw/sessions/{N}.json", async () => {
    const { fs, writes } = memoryFs();
    await saveSession(
      CWD,
      { issueNumber: 3, sessionId: "abc", fixAttempts: 0 },
      fs,
    );
    const path = `${CWD}/.claw/sessions/3.json`;
    expect(writes[path]).toBe(serializeSession({
      issueNumber: 3,
      sessionId: "abc",
      fixAttempts: 0,
    }));
  });
});

describe("loadSession", () => {
  it("returns null when the file is missing", async () => {
    const { fs } = memoryFs();
    const result = await loadSession(CWD, 42, fs);
    expect(result).toBeNull();
  });

  it("returns the parsed session when present", async () => {
    const path = `${CWD}/.claw/sessions/42.json`;
    const { fs } = memoryFs({
      [path]: serializeSession({
        issueNumber: 42,
        sessionId: "sid",
        fixAttempts: 2,
      }),
    });
    const result = await loadSession(CWD, 42, fs);
    expect(result).toEqual({
      issueNumber: 42,
      sessionId: "sid",
      fixAttempts: 2,
    });
  });

  it("returns null when the file contents are malformed", async () => {
    const path = `${CWD}/.claw/sessions/42.json`;
    const { fs } = memoryFs({ [path]: "not json" });
    const result = await loadSession(CWD, 42, fs);
    expect(result).toBeNull();
  });
});

describe("deleteSession", () => {
  it("removes the canonical session path", async () => {
    const path = `${CWD}/.claw/sessions/7.json`;
    const { fs, removes, writes } = memoryFs({ [path]: "anything" });
    await deleteSession(CWD, 7, fs);
    expect(removes).toEqual([path]);
    expect(writes[path]).toBeUndefined();
  });

  it("does not throw when the file is absent", async () => {
    const { fs } = memoryFs();
    await expect(deleteSession(CWD, 7, fs)).resolves.toBeUndefined();
  });
});
