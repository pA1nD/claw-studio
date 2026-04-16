import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import {
  DEFAULT_MILESTONE,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REPO,
  DEFAULT_TIMEOUT_SECONDS,
  buildIssueResults,
  ensureWorkspace,
  main as harnessMain,
  mintRunId,
  monitorLoop,
  parseHarnessArgs,
  readSessionFilesFromDisk,
  recordResult,
  resolveOptions,
  runBenchmark,
  runTests,
} from "../../benchmark/harness.js";
import type {
  HarnessDeps,
  HarnessLogger,
  HarnessOptions,
  ShellResult,
  SpawnHandle,
} from "../../benchmark/harness.js";
import type { CopiedIssue } from "../../benchmark/github.js";
import type { RunResult } from "../../benchmark/types.js";

const REPO = "pA1nD/claw-e2e-mdcast";

/** In-memory logger that records every line so tests can assert output. */
function recordingLogger(): HarnessLogger & {
  info_lines: string[];
  warn_lines: string[];
  error_lines: string[];
} {
  const info_lines: string[] = [];
  const warn_lines: string[] = [];
  const error_lines: string[] = [];
  return {
    info_lines,
    warn_lines,
    error_lines,
    info: (line) => info_lines.push(line),
    warn: (line) => warn_lines.push(line),
    error: (line) => error_lines.push(line),
  };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(
    tmpdir(),
    `claw-bench-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveOptions", () => {
  it("applies every default when nothing is passed", () => {
    const resolved = resolveOptions();
    expect(resolved.repo).toBe(DEFAULT_REPO);
    expect(resolved.milestone).toBe(DEFAULT_MILESTONE);
    expect(resolved.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    expect(resolved.pollIntervalSeconds).toBe(DEFAULT_POLL_INTERVAL_SECONDS);
    expect(resolved.trackingIssue).toBeNull();
    expect(resolved.dryRun).toBe(false);
    expect(resolved.clawBin).toBe("claw");
  });

  it("honours caller overrides", () => {
    const resolved = resolveOptions({
      repo: "example/other",
      timeout: 60,
      trackingIssue: 42,
      dryRun: true,
      clawBin: "/usr/local/bin/claw",
    });
    expect(resolved.repo).toBe("example/other");
    expect(resolved.timeoutSeconds).toBe(60);
    expect(resolved.trackingIssue).toBe(42);
    expect(resolved.dryRun).toBe(true);
    expect(resolved.clawBin).toBe("/usr/local/bin/claw");
  });
});

describe("parseHarnessArgs", () => {
  it("parses every flag", () => {
    const cli = parseHarnessArgs([
      "--repo",
      "example/other",
      "--milestone",
      "v0.2",
      "--initial-tag",
      "seed",
      "--timeout",
      "300",
      "--poll-interval",
      "10",
      "--tracking-issue",
      "7",
      "--bench-root",
      "/tmp/bench",
      "--claw-bin",
      "/usr/local/bin/claw",
      "--dry-run",
    ]);
    expect(cli).toEqual({
      repo: "example/other",
      milestone: "v0.2",
      initialTag: "seed",
      timeout: 300,
      pollInterval: 10,
      trackingIssue: 7,
      benchRoot: "/tmp/bench",
      clawBin: "/usr/local/bin/claw",
      dryRun: true,
    });
  });

  it("leaves unspecified flags undefined so defaults survive", () => {
    const cli = parseHarnessArgs([]);
    expect(cli).toEqual({});
  });

  it("rejects non-positive numeric flags", () => {
    expect(() => parseHarnessArgs(["--timeout", "0"])).toThrow(/--timeout/);
    expect(() => parseHarnessArgs(["--poll-interval", "-5"])).toThrow(/--poll-interval/);
  });
});

describe("mintRunId", () => {
  it("queries labels and mints the next iteration", async () => {
    const listLabelsForRepo = vi.fn(async () => ({
      data: [{ name: "v0.1-001" }, { name: "v0.1-002" }, { name: "other" }],
    }));
    const octokit = {
      paginate: async (_m: unknown, _p: unknown) => {
        const r = await listLabelsForRepo();
        return r.data;
      },
      issues: { listLabelsForRepo },
    } as unknown as Octokit;

    const id = await mintRunId(octokit, { owner: "a", repo: "b" }, "v0.1");
    expect(id.label).toBe("v0.1-003");
    expect(id.iteration).toBe(3);
  });
});

describe("buildIssueResults", () => {
  const copies: CopiedIssue[] = [
    { number: 10, template: 1, title: "scaffold" },
    { number: 11, template: 2, title: "cli" },
    { number: 12, template: 3, title: "parser" },
  ];

  it("merges when the issue is closed without the needs-human label", () => {
    const rows = [
      { number: 10, state: "closed" as const, labels: ["v0.1-001"] },
      { number: 11, state: "closed" as const, labels: ["v0.1-001", "needs-human"] },
      { number: 12, state: "open" as const, labels: ["v0.1-001"] },
    ];
    const sessions = [{ issueNumber: 11, fixAttempts: 3 }];
    const results = buildIssueResults(copies, rows, sessions);
    expect(results).toEqual([
      {
        number: 10,
        template: 1,
        title: "scaffold",
        merged: true,
        escalated: false,
        fixCycles: 0,
      },
      {
        number: 11,
        template: 2,
        title: "cli",
        merged: false,
        escalated: true,
        fixCycles: 3,
      },
      {
        number: 12,
        template: 3,
        title: "parser",
        merged: false,
        escalated: false,
        fixCycles: 0,
      },
    ]);
  });

  it("treats missing rows defensively (no crash, marks unmerged)", () => {
    const rows: Array<{ number: number; state: "open" | "closed"; labels: string[] }> =
      [];
    const results = buildIssueResults(copies, rows, []);
    expect(results.every((r) => !r.merged)).toBe(true);
  });
});

describe("monitorLoop", () => {
  it("exits as soon as every iteration issue closes", async () => {
    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ number: 1, state: "open", labels: [] }] })
      .mockResolvedValueOnce({ data: [{ number: 1, state: "closed", labels: [] }] });
    const octokit = {
      paginate: async (_m: unknown, _p: unknown) => {
        const r = await listForRepo();
        return r.data;
      },
      issues: { listForRepo },
    } as unknown as Octokit;

    const sleep = vi.fn(async () => {});
    let currentTime = 0;
    const now = () => currentTime;
    await monitorLoop({
      octokit,
      ref: { owner: "a", repo: "b" },
      iterationLabel: "v0.1-001",
      timeoutMs: 1_000_000,
      pollIntervalMs: 1,
      startedAt: 0,
      now,
      sleep: async (ms) => {
        currentTime += ms;
        await sleep(ms);
      },
      isLoopDone: () => false,
    });
    expect(listForRepo).toHaveBeenCalledTimes(2);
  });

  it("honours the timeout", async () => {
    const listForRepo = vi.fn(async () => ({
      data: [{ number: 1, state: "open", labels: [] }],
    }));
    const octokit = {
      paginate: async (_m: unknown, _p: unknown) => {
        const r = await listForRepo();
        return r.data;
      },
      issues: { listForRepo },
    } as unknown as Octokit;

    let currentTime = 0;
    const log = recordingLogger();
    await monitorLoop({
      octokit,
      ref: { owner: "a", repo: "b" },
      iterationLabel: "v0.1-001",
      timeoutMs: 10,
      pollIntervalMs: 5,
      startedAt: 0,
      now: () => currentTime,
      sleep: async (ms) => {
        currentTime += ms;
      },
      isLoopDone: () => false,
      logger: log,
    });
    expect(log.warn_lines.some((l) => l.includes("wall-clock timeout"))).toBe(true);
  });

  it("gracefully exits one poll after the loop process is observed done", async () => {
    let call = 0;
    const listForRepo = vi.fn(async () => {
      call += 1;
      return { data: [{ number: 1, state: "open", labels: [] }] };
    });
    const octokit = {
      paginate: async (_m: unknown, _p: unknown) => {
        const r = await listForRepo();
        return r.data;
      },
      issues: { listForRepo },
    } as unknown as Octokit;

    let time = 0;
    await monitorLoop({
      octokit,
      ref: { owner: "a", repo: "b" },
      iterationLabel: "v0.1-001",
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      startedAt: 0,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      isLoopDone: () => call >= 1, // done after first poll
    });
    // First poll runs; observes isLoopDone; grace-period sleep then exit.
    expect(call).toBe(1);
  });
});

describe("runTests", () => {
  it("parses vitest output on success", async () => {
    const shell = vi.fn(async (cmd: string, _args: readonly string[]) => {
      if (cmd === "npm" && _args[0] === "install") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "      Tests  5 passed (5)\n",
        stderr: "",
        exitCode: 0,
      };
    });
    const totals = await runTests("/tmp/x", shell);
    expect(totals).toEqual({ total: 5, passing: 5 });
  });

  it("returns zero totals when npm install fails", async () => {
    const log = recordingLogger();
    const shell = vi.fn(async (cmd: string) => {
      if (cmd === "npm") throw new Error("install failed");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const totals = await runTests("/tmp/x", shell, log);
    expect(totals).toEqual({ total: 0, passing: 0 });
    expect(log.warn_lines.some((l) => l.includes("npm install failed"))).toBe(true);
  });

  it("still parses test output when npm test exits non-zero (failures present)", async () => {
    const shell = vi.fn(
      async (cmd: string, args: readonly string[]): Promise<ShellResult> => {
        if (cmd === "npm" && args[0] === "install") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        const err: Error & { stdout?: string; stderr?: string; exitCode?: number } =
          new Error("tests failed");
        err.stdout = "      Tests  2 failed | 3 passed (5)\n";
        err.stderr = "";
        err.exitCode = 1;
        throw err;
      },
    );
    const totals = await runTests("/tmp/x", shell);
    expect(totals).toEqual({ total: 5, passing: 3 });
  });

  it("returns zero when test output is unparseable", async () => {
    const log = recordingLogger();
    const shell = vi.fn(
      async (_cmd: string, _args: readonly string[]): Promise<ShellResult> => ({
        stdout: "nothing here",
        stderr: "",
        exitCode: 0,
      }),
    );
    const totals = await runTests("/tmp/x", shell, log);
    expect(totals).toEqual({ total: 0, passing: 0 });
    expect(log.warn_lines.some((l) => l.includes("could not parse"))).toBe(true);
  });
});

describe("readSessionFilesFromDisk", () => {
  it("returns snapshots for every valid session file", async () => {
    await withTmp(async (dir) => {
      const sessionsDir = join(dir, ".claw", "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "7.json"),
        JSON.stringify({ issueNumber: 7, sessionId: "abc", fixAttempts: 2 }),
      );
      await writeFile(
        join(sessionsDir, "8.json"),
        JSON.stringify({ issueNumber: 8, sessionId: "def", fixAttempts: 0 }),
      );
      await writeFile(join(sessionsDir, "bad.json"), "not-json");
      await writeFile(join(sessionsDir, "ignored.txt"), "nope");

      const snaps = await readSessionFilesFromDisk(dir);
      const byNumber = new Map(snaps.map((s) => [s.issueNumber, s]));
      expect(byNumber.get(7)?.fixAttempts).toBe(2);
      expect(byNumber.get(8)?.fixAttempts).toBe(0);
      expect(snaps).toHaveLength(2);
    });
  });

  it("returns empty when the sessions dir does not exist", async () => {
    await withTmp(async (dir) => {
      const snaps = await readSessionFilesFromDisk(dir);
      expect(snaps).toEqual([]);
    });
  });
});

describe("recordResult", () => {
  it("writes the JSON file under results/", async () => {
    await withTmp(async (dir) => {
      const result: RunResult = {
        runId: "v0.1-001",
        timestamp: "2026-04-16T22:30:00Z",
        repo: REPO,
        durationSeconds: 100,
        scores: {
          completion: 1,
          correctness: 1,
          efficiency: 1,
          autonomy: 1,
          composite: 1,
        },
        issues: [],
      };
      const path = await recordResult(dir, result);
      const round = JSON.parse(await readFile(path, "utf8")) as RunResult;
      expect(round.runId).toBe("v0.1-001");
      expect(round.scores.composite).toBe(1);
    });
  });
});

describe("ensureWorkspace", () => {
  it("clones the repo when the target does not exist", async () => {
    await withTmp(async (dir) => {
      const shell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      const target = await ensureWorkspace(dir, { owner: "a", repo: "b" }, { shell });
      expect(target).toBe(join(dir, "repos", "b"));
      const cloneCall = shell.mock.calls[0];
      expect(cloneCall?.[0]).toBe("git");
      expect(cloneCall?.[1]).toContain("clone");
    });
  });

  it("resets when the target already exists", async () => {
    await withTmp(async (dir) => {
      const target = join(dir, "repos", "b");
      await mkdir(join(target, ".git"), { recursive: true });
      await writeFile(join(target, ".git", "HEAD"), "ref: refs/heads/main\n");

      const shell = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
      await ensureWorkspace(dir, { owner: "a", repo: "b" }, { shell });
      const firstCall = shell.mock.calls[0];
      expect(firstCall?.[1]).toContain("fetch");
      const lastCall = shell.mock.calls.at(-1);
      expect(lastCall?.[1]).toContain("reset");
    });
  });
});

describe("main", () => {
  it("exits cleanly (code 0) when invoked with --help", async () => {
    // Commander writes --help straight to stdout; mute it so the test
    // output stays readable.
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const code = await harnessMain(["--help"]);
      expect(code).toBe(0);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe("runBenchmark – dry run", () => {
  it("performs setup, stops after template copy, and returns a zeroed result", async () => {
    const ref = { owner: "pA1nD", repo: "claw-e2e-mdcast" };
    const labels = ["v0.1-001"];
    const templates = [
      { number: 1, title: "Scaffold", body: "b1", pull_request: undefined },
      { number: 2, title: "CLI", body: "b2", pull_request: undefined },
    ];
    const creates: Array<{ title: string }> = [];

    const octokit = {
      paginate: async (method: unknown, params: unknown) => {
        const r = await (method as (p: unknown) => Promise<{ data: unknown[] }>)(params);
        return r.data;
      },
      issues: {
        listLabelsForRepo: vi.fn(async () => ({
          data: labels.map((name) => ({ name })),
        })),
        createLabel: vi.fn(async () => ({ data: {} })),
        listForRepo: vi.fn(async () => ({ data: templates })),
        create: vi.fn(async (p: unknown) => {
          const { title } = p as { title: string };
          creates.push({ title });
          return { data: { number: 100 + creates.length, title } };
        }),
      },
      git: {
        getRef: vi.fn(async () => ({
          data: { object: { type: "commit", sha: "c850fc5" } },
        })),
        updateRef: vi.fn(async () => ({ data: {} })),
      },
      repos: {
        getContent: vi.fn(async () => ({
          data: {
            content: Buffer.from("## Current milestone: v0.1\n").toString("base64"),
            encoding: "base64",
            sha: "blob",
          },
        })),
        createOrUpdateFileContents: vi.fn(async () => ({
          data: { commit: { sha: "deadbeef" } },
        })),
      },
      pulls: {},
    } as unknown as Octokit;

    await withTmp(async (benchRoot) => {
      const shell: NonNullable<HarnessDeps["shell"]> = vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }));
      const spawn: NonNullable<HarnessDeps["spawn"]> = (): SpawnHandle => ({
        exit: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
        kill: () => {},
      });

      const options: HarnessOptions = {
        repo: `${ref.owner}/${ref.repo}`,
        milestone: "v0.1",
        initialTag: "initial",
        timeoutSeconds: 10,
        pollIntervalSeconds: 1,
        trackingIssue: null,
        benchRoot,
        dryRun: true,
        clawBin: "claw",
      };

      const log = recordingLogger();
      const result = await runBenchmark(options, {
        makeOctokit: () => octokit,
        shell,
        spawn,
        sleep: async () => {},
        now: () => 0,
        readSessionFiles: async () => [],
        logger: log,
      });
      expect(log.info_lines.some((l) => l.includes("starting run"))).toBe(true);

      expect(result.runId).toBe("v0.1-002"); // labels had v0.1-001 already
      expect(result.repo).toBe(`${ref.owner}/${ref.repo}`);
      expect(result.issues).toHaveLength(2);
      expect(result.issues.every((i) => !i.merged)).toBe(true);
      expect(creates.map((c) => c.title)).toEqual(["Scaffold", "CLI"]);
    });
  });
});
