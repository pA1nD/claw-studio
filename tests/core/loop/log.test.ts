import { describe, expect, it, vi } from "vitest";
import {
  appendLog,
  logPath,
  readLastEntries,
  type LogFs,
} from "../../../src/core/loop/log.js";

const CWD = "/tmp/proj";

/** Build an in-memory log fs. */
function memoryFs(initial: string | null = null): LogFs & { content: string } {
  const state = { content: initial ?? "" };
  return {
    get content() {
      return state.content;
    },
    appendFile: vi.fn(async (_path: string, contents: string) => {
      state.content += contents;
    }),
    readFile: vi.fn(async () => (initial === null && state.content === "" ? null : state.content)),
  };
}

describe("logPath", () => {
  it("places the log inside `.claw/`", () => {
    expect(logPath(CWD)).toBe("/tmp/proj/.claw/loop.log");
  });
});

describe("appendLog", () => {
  it("writes a single line in `ISO\\tline\\n` format", async () => {
    const fs = memoryFs();
    const fixed = new Date("2026-04-16T01:02:03.000Z");
    await appendLog(CWD, "hello world", fs, () => fixed);
    expect(fs.content).toBe("2026-04-16T01:02:03.000Z\thello world\n");
  });

  it("uses the resolved log path", async () => {
    const fs = memoryFs();
    await appendLog(CWD, "x", fs);
    expect(fs.appendFile).toHaveBeenCalledWith(
      logPath(CWD),
      expect.stringContaining("\tx\n"),
    );
  });

  it("appends repeatedly without losing earlier lines", async () => {
    const fs = memoryFs();
    await appendLog(CWD, "first", fs, () => new Date(0));
    await appendLog(CWD, "second", fs, () => new Date(1));
    expect(fs.content.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("readLastEntries", () => {
  it("returns an empty array when the file does not exist", async () => {
    const fs: LogFs = {
      appendFile: vi.fn(),
      readFile: vi.fn(async () => null),
    };
    expect(await readLastEntries(CWD, 5, fs)).toEqual([]);
  });

  it("returns the trailing N entries in chronological order", async () => {
    const fs: LogFs = {
      appendFile: vi.fn(),
      readFile: vi.fn(async () => "a\nb\nc\nd\ne\n"),
    };
    expect(await readLastEntries(CWD, 3, fs)).toEqual(["c", "d", "e"]);
  });

  it("returns every entry when N exceeds the count", async () => {
    const fs: LogFs = {
      appendFile: vi.fn(),
      readFile: vi.fn(async () => "a\nb\n"),
    };
    expect(await readLastEntries(CWD, 100, fs)).toEqual(["a", "b"]);
  });

  it("returns an empty array when N is zero or negative", async () => {
    const fs: LogFs = {
      appendFile: vi.fn(),
      readFile: vi.fn(async () => "a\nb\n"),
    };
    expect(await readLastEntries(CWD, 0, fs)).toEqual([]);
    expect(await readLastEntries(CWD, -3, fs)).toEqual([]);
  });

  it("filters out empty lines from a trailing newline", async () => {
    const fs: LogFs = {
      appendFile: vi.fn(),
      readFile: vi.fn(async () => "a\n\nb\n"),
    };
    expect(await readLastEntries(CWD, 5, fs)).toEqual(["a", "b"]);
  });
});
