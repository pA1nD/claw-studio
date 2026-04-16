import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../../../src/core/types/errors.js";
import type { ClawConfig } from "../../../src/core/setup/config.js";
import {
  formatCycle,
  startLoop,
} from "../../../src/core/loop/start-loop.js";
import type { CycleResult } from "../../../src/core/loop/orchestrator.js";
import { IDLE_WARNING_MS } from "../../../src/core/loop/orchestrator.js";
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

/**
 * The idle warning fires when `now() - lastActionAt > IDLE_WARNING_MS` AND
 * `idleWarningEmitted` is false. To exercise it deterministically each test
 * controls the wall clock via the `now` seam: the first cycle establishes
 * `lastActionAt`, subsequent cycles fast-forward past the threshold.
 *
 * The auto-continue cycle returns `milestone-complete` repeatedly without
 * `action-taken` — the perfect "no state change" signal the idle detector is
 * built to surface.
 */
describe("startLoop — idle warning", () => {
  /** Build inspector deps that always return milestone-complete (no action). */
  function noActionInspectorDeps() {
    return {
      readRoadmap: async () => "## Current milestone: v0.1\n",
      listIssuesForLabel: async () => [
        {
          number: 7,
          title: "x",
          state: "closed" as const,
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
    };
  }

  function noActionRoadmapDeps() {
    return {
      readRoadmap: async () => "## Current milestone: v0.1\n",
      listIssuesForLabel: async () => [
        {
          number: 7,
          title: "x",
          state: "closed" as const,
          labels: ["v0.1"],
          body: "",
        },
      ],
    };
  }

  it("appends a WARNING line after IDLE_WARNING_MS with no action-taken", async () => {
    const ctrl = controlFs();
    const log = logFs();
    // First `now()` call sets `lastActionAt` to 0; after one cycle,
    // fast-forward past the threshold so the idle check fires; after the
    // second cycle, set the stop flag so the loop exits.
    let nowCalls = 0;
    const now = () => {
      nowCalls += 1;
      // Calls 1 and 2: time 0 (initial lastActionAt + first idle check baseline).
      // From call 3 onwards: past the idle threshold.
      return nowCalls <= 1 ? 0 : IDLE_WARNING_MS + 1;
    };
    let cycles = 0;
    const sleep = vi.fn(async () => {
      cycles += 1;
      if (cycles >= 2) {
        ctrl.files.add(`${CWD}/.claw/control/stop`);
      }
    });

    await startLoop(CONFIG, {
      cwd: CWD,
      autoContinue: true,
      controlFs: ctrl,
      logFs: log,
      sleep,
      now,
      client: stubClient,
      deps: {
        roadmap: noActionRoadmapDeps(),
        inspector: noActionInspectorDeps(),
      },
    });

    const warnings = log.lines.filter((l) => l.includes("WARNING idle"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    // The warning text references the threshold in minutes.
    expect(warnings[0]).toContain(`${Math.floor(IDLE_WARNING_MS / 60_000)}m`);
  });

  it("emits the idle warning at most once until the next action-taken cycle", async () => {
    const ctrl = controlFs();
    const log = logFs();
    let nowCalls = 0;
    const now = () => {
      nowCalls += 1;
      return nowCalls <= 1 ? 0 : IDLE_WARNING_MS + 1;
    };
    let cycles = 0;
    const sleep = vi.fn(async () => {
      cycles += 1;
      // Run several idle cycles so the de-dup flag has multiple chances to fire
      // a duplicate warning.
      if (cycles >= 4) {
        ctrl.files.add(`${CWD}/.claw/control/stop`);
      }
    });

    await startLoop(CONFIG, {
      cwd: CWD,
      autoContinue: true,
      controlFs: ctrl,
      logFs: log,
      sleep,
      now,
      client: stubClient,
      deps: {
        roadmap: noActionRoadmapDeps(),
        inspector: noActionInspectorDeps(),
      },
    });

    const warnings = log.lines.filter((l) => l.includes("WARNING idle"));
    expect(warnings).toHaveLength(1);
  });

  it("resets the idle detector after an action-taken cycle so a fresh idle period re-warns", async () => {
    const ctrl = controlFs();
    const log = logFs();
    // Use the cycle's onCycle callback to drive the cycle plan:
    //   cycle 1 — milestone-complete (idle, fires warning #1)
    //   cycle 2 — action-taken (resets the idle de-dup flag)
    //   cycle 3+ — milestone-complete (idle again, fires warning #2)
    let onCycleCount = 0;
    let openIssueOnNextCycle = false;
    const buildIssues = () => [
      {
        number: 7,
        title: "x",
        state: openIssueOnNextCycle ? ("open" as const) : ("closed" as const),
        labels: ["v0.1"],
        body: "",
      },
    ];

    const sleep = vi.fn(async () => undefined);
    // Each call to `now()` advances the clock by the full idle threshold + 1ms
    // so the gap from `lastActionAt` to the next idle check is always over
    // the threshold. The startup `now()` sets `lastActionAt`; subsequent
    // calls (idle check + post-action reset) walk the clock forward.
    let clockTick = 0;
    const now = () => {
      clockTick += IDLE_WARNING_MS + 1;
      return clockTick;
    };

    await startLoop(CONFIG, {
      cwd: CWD,
      autoContinue: true,
      controlFs: ctrl,
      logFs: log,
      sleep,
      now,
      onCycle: (result) => {
        onCycleCount += 1;
        // After the first idle cycle, switch to "action" mode for cycle 2.
        if (onCycleCount === 1) {
          openIssueOnNextCycle = true;
        }
        // After the action cycle, revert to idle so cycle 3 fires the second
        // warning.
        if (result.type === "action-taken") {
          openIssueOnNextCycle = false;
        }
        // Stop after enough cycles to give both warnings a chance to land.
        if (onCycleCount >= 4) {
          ctrl.files.add(`${CWD}/.claw/control/stop`);
        }
      },
      client: stubClient,
      deps: {
        roadmap: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => buildIssues(),
        },
        inspector: {
          readRoadmap: async () => "## Current milestone: v0.1\n",
          listIssuesForLabel: async () => buildIssues(),
          readDefaultBranch: async () => "main",
          listBranches: async () => [{ name: "main", sha: "x" }],
          listOpenPullRequests: async () => [],
          compareBranchToDefault: async () => ({ behindBy: 0 }),
          listPRCommentBodies: async () => [],
          readSession: async () => null,
          listFailingChecks: async () => [],
        },
        // Without this, the orchestrator falls back to buildDefaultListOpenPRs
        // which calls the (stub) Octokit and throws — turning the action cycle
        // into a halt and exiting the loop before we observe the second
        // warning. The inspector's listOpenPullRequests is a separate dep
        // (used by CHECKS 5/7/8/10/11/12/13).
        listOpenPullRequests: async () => [],
        readRoadmapContent: async () => "## Current milestone: v0.1\n",
        runImplementationAgent: async () => ({
          branch: "claw/issue-7-x",
          prNumber: 100,
          sessionId: "s",
        }),
      },
    });

    const warnings = log.lines.filter((l) => l.includes("WARNING idle"));
    // Two warnings — the de-dup flag reset after the action-taken cycle.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
