import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../../../src/core/types/errors.js";
import type { ClawConfig } from "../../../src/core/setup/config.js";
import {
  formatCycle,
  startLoop,
} from "../../../src/core/loop/start-loop.js";
import type { CycleResult } from "../../../src/core/loop/orchestrator.js";
import type { ControlFs } from "../../../src/core/loop/control.js";
import type { LogFs } from "../../../src/core/loop/log.js";

const stubClient = {} as Octokit;
const CWD = "/tmp/proj";

const CONFIG: ClawConfig = {
  repo: "pA1nD/claw-studio",
  pollInterval: 60,
  clawVersion: "0.0.1",
};

/** Build an in-memory control fs starting with the given flag set. */
function controlFs(initial: { paused?: boolean; stopped?: boolean } = {}): ControlFs & {
  files: Set<string>;
} {
  const files = new Set<string>();
  if (initial.paused) files.add(`${CWD}/.claw/control/pause`);
  if (initial.stopped) files.add(`${CWD}/.claw/control/stop`);
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

/** Build an in-memory log fs that records every line. */
function logFs(): LogFs & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendFile: vi.fn(async (_path: string, contents: string) => {
      // each appendLog call writes one full line ending in "\n"
      lines.push(contents.replace(/\n$/, ""));
    }),
    readFile: vi.fn(async () => null),
  };
}

describe("formatCycle", () => {
  it("formats action-taken with an ACTION prefix", () => {
    expect(formatCycle({ type: "action-taken", action: "merged PR" })).toBe(
      "ACTION merged PR",
    );
  });

  it("formats waiting with a WAIT prefix", () => {
    expect(formatCycle({ type: "waiting", reason: "review pending" })).toBe(
      "WAIT review pending",
    );
  });

  it("formats halted with only the message — never the hint or the full error", () => {
    const err = new ClawError("CI failing.", "Run claw status.");
    expect(formatCycle({ type: "halted", error: err })).toBe("HALT CI failing.");
  });

  it("formats milestone-complete with the milestone name", () => {
    expect(
      formatCycle({ type: "milestone-complete", milestone: "v0.1" }),
    ).toBe("MILESTONE_COMPLETE v0.1");
  });

  it("formats paused with a static message", () => {
    expect(formatCycle({ type: "paused" })).toBe("PAUSED waiting for resume");
  });
});

describe("startLoop — exit conditions", () => {
  it("exits cleanly when the stop flag is set before the first cycle", async () => {
    const ctrl = controlFs();
    // Set stop AFTER startLoop's clearStopFlag runs by intercepting the first
    // `exists` call to return true.
    ctrl.exists = vi.fn(async (p: string) =>
      p.endsWith("/stop") ? true : false,
    );
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: logFs(),
      sleep: vi.fn(async () => undefined),
      // Inject a stub client so the loop never reaches createClient (which
      // would throw on missing GITHUB_PAT in the test environment).
      client: stubClient,
    });
    expect(result).toEqual({ type: "stopped" });
  });

  it("exits with halted when the cycle returns halted", async () => {
    const ctrl = controlFs();
    const log = logFs();
    const halted: CycleResult = {
      type: "halted",
      error: new ClawError("network down."),
    };
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: log,
      sleep: vi.fn(async () => undefined),
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "open",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        readRoadmapContent: async () => "## Current milestone: v0.1\n",
        listOpenPullRequests: async () => {
          throw new Error("network down.");
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "open",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result.type).toBe("halted");
    if (result.type !== "halted") return;
    expect(result.error.message).toBe("network down.");
    // Log line should contain the halted prefix.
    expect(log.lines.some((l) => l.includes("HALT network down."))).toBe(true);
    // Halted log line is just the message — no hint, no Octokit details.
    expect(log.lines.some((l) => l.includes("token"))).toBe(false);
  });

  it("exits with milestone-complete when not auto-continuing", async () => {
    const ctrl = controlFs();
    const log = logFs();
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: log,
      sleep: vi.fn(async () => undefined),
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result).toEqual({
      type: "milestone-complete",
      milestone: "v0.1",
    });
    expect(log.lines.some((l) => l.includes("MILESTONE_COMPLETE v0.1"))).toBe(
      true,
    );
  });

  it("respects the pause flag — sleeps and re-polls without running a cycle", async () => {
    // Start paused; flip the pause flag to false after one paused tick.
    let polls = 0;
    const ctrl = controlFs({ paused: true });
    const cycleResults: (CycleResult | { type: "paused" })[] = [];

    // After one paused poll, clear the pause flag so the next iteration runs
    // a real cycle that returns milestone-complete.
    const sleep = vi.fn(async () => {
      polls += 1;
      if (polls === 1) {
        ctrl.files.delete(`${CWD}/.claw/control/pause`);
      }
    });

    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: logFs(),
      sleep,
      onCycle: (r) => cycleResults.push(r),
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result.type).toBe("milestone-complete");
    // First onCycle callback should be the paused signal.
    expect(cycleResults[0]?.type).toBe("paused");
    // Then the milestone-complete cycle ran.
    expect(
      cycleResults.some((r) => r.type === "milestone-complete"),
    ).toBe(true);
  });

  it("clears any stale stop flag at startup", async () => {
    const ctrl = controlFs({ stopped: true });
    // After clearStopFlag, the cycle returns milestone-complete and the loop
    // exits cleanly — proving the stale flag was cleared.
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: logFs(),
      sleep: vi.fn(async () => undefined),
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result.type).toBe("milestone-complete");
    expect(ctrl.remove).toHaveBeenCalledWith(`${CWD}/.claw/control/stop`);
  });

  it("dryRun exits after a single cycle", async () => {
    const ctrl = controlFs();
    const log = logFs();
    let cycles = 0;
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: log,
      sleep: vi.fn(async () => undefined),
      dryRun: true,
      onCycle: () => {
        cycles += 1;
      },
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "open",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        readRoadmapContent: async () => "## Current milestone: v0.1\n",
        listOpenPullRequests: async () => [],
        runImplementationAgent: async () => ({
          branch: "claw/issue-7-x",
          prNumber: 100,
          sessionId: "s",
        }),
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "open",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result).toEqual({ type: "stopped" });
    expect(cycles).toBe(1);
  });

  it("logging failures never propagate — the loop keeps running", async () => {
    const ctrl = controlFs();
    const failingLog: LogFs = {
      appendFile: vi.fn(async () => {
        throw new Error("disk full");
      }),
      readFile: vi.fn(async () => null),
    };
    const result = await startLoop(CONFIG, {
      cwd: CWD,
      controlFs: ctrl,
      logFs: failingLog,
      sleep: vi.fn(async () => undefined),
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });
    // The cycle finished and the loop returned a normal result despite the log
    // failure.
    expect(result.type).toBe("milestone-complete");
  });

  it("auto-continue keeps polling past milestone-complete until stop is set", async () => {
    const ctrl = controlFs();
    let cycles = 0;
    const sleep = vi.fn(async () => {
      cycles += 1;
      if (cycles === 2) {
        ctrl.files.add(`${CWD}/.claw/control/stop`);
      }
    });

    const result = await startLoop(CONFIG, {
      cwd: CWD,
      autoContinue: true,
      controlFs: ctrl,
      logFs: logFs(),
      sleep,
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => [
            {
              number: 7,
              title: "x",
              state: "closed",
              labels: ["v0.1"],
              body: "",
            },
          ],
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
      },
    });

    expect(result).toEqual({ type: "stopped" });
    // The loop ran multiple cycles (each milestone-complete), only exiting
    // when stop was flipped.
    expect(cycles).toBeGreaterThanOrEqual(2);
  });
});
