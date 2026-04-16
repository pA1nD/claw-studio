import { describe, expect, it, vi } from "vitest";
import {
  clearPauseFlag,
  clearStopFlag,
  controlPaths,
  isPaused,
  isStopped,
  setPauseFlag,
  setStopFlag,
  type ControlFs,
} from "../../../src/core/loop/control.js";

const CWD = "/tmp/proj";

/** Build an in-memory control fs. */
function memoryFs(initial: Set<string> = new Set()): ControlFs & {
  files: Set<string>;
} {
  const files = new Set(initial);
  return {
    files,
    exists: vi.fn(async (p: string) => files.has(p)),
    writeEmpty: vi.fn(async (p: string) => {
      files.add(p);
    }),
    remove: vi.fn(async (p: string) => {
      files.delete(p);
    }),
  };
}

describe("controlPaths", () => {
  it("places the pause/stop flags inside `.claw/control/`", () => {
    const paths = controlPaths(CWD);
    expect(paths.pauseFlag).toBe("/tmp/proj/.claw/control/pause");
    expect(paths.stopFlag).toBe("/tmp/proj/.claw/control/stop");
    expect(paths.controlDir).toBe("/tmp/proj/.claw/control");
  });
});

describe("pause flag", () => {
  it("setPauseFlag → isPaused returns true", async () => {
    const fs = memoryFs();
    await setPauseFlag(CWD, fs);
    expect(await isPaused(CWD, fs)).toBe(true);
  });

  it("clearPauseFlag → isPaused returns false", async () => {
    const fs = memoryFs(new Set([controlPaths(CWD).pauseFlag]));
    expect(await isPaused(CWD, fs)).toBe(true);
    await clearPauseFlag(CWD, fs);
    expect(await isPaused(CWD, fs)).toBe(false);
  });

  it("clearPauseFlag is a no-op when no flag exists", async () => {
    const fs = memoryFs();
    await expect(clearPauseFlag(CWD, fs)).resolves.toBeUndefined();
    expect(await isPaused(CWD, fs)).toBe(false);
  });
});

describe("stop flag", () => {
  it("setStopFlag → isStopped returns true", async () => {
    const fs = memoryFs();
    await setStopFlag(CWD, fs);
    expect(await isStopped(CWD, fs)).toBe(true);
  });

  it("clearStopFlag → isStopped returns false", async () => {
    const fs = memoryFs(new Set([controlPaths(CWD).stopFlag]));
    expect(await isStopped(CWD, fs)).toBe(true);
    await clearStopFlag(CWD, fs);
    expect(await isStopped(CWD, fs)).toBe(false);
  });

  it("pause and stop flags are independent", async () => {
    const fs = memoryFs();
    await setPauseFlag(CWD, fs);
    expect(await isPaused(CWD, fs)).toBe(true);
    expect(await isStopped(CWD, fs)).toBe(false);
    await setStopFlag(CWD, fs);
    expect(await isStopped(CWD, fs)).toBe(true);
    await clearPauseFlag(CWD, fs);
    expect(await isPaused(CWD, fs)).toBe(false);
    expect(await isStopped(CWD, fs)).toBe(true);
  });
});
