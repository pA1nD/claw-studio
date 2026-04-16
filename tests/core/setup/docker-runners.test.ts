import { describe, it, expect, vi } from "vitest";
import {
  generateRunnerComposeFile,
  renderComposeFile,
  requestRunnerRegistrationToken,
  startRunners,
} from "../../../src/core/setup/docker-runners.js";
import { ClawError } from "../../../src/core/types/errors.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };

describe("renderComposeFile", () => {
  it("emits one service per runner with distinct names", () => {
    const yaml = renderComposeFile({
      ref,
      runnerCount: 3,
      registrationToken: "reg-tok",
      claudeToken: "clm-tok",
    });
    expect(yaml).toContain("claw-runner-1:");
    expect(yaml).toContain("claw-runner-2:");
    expect(yaml).toContain("claw-runner-3:");
    expect(yaml).not.toContain("claw-runner-4:");
  });

  it("embeds the repo URL, registration token, and Claude token", () => {
    const yaml = renderComposeFile({
      ref,
      runnerCount: 1,
      registrationToken: "reg-tok",
      claudeToken: "clm-tok",
    });
    expect(yaml).toContain("https://github.com/pA1nD/claw-studio");
    expect(yaml).toContain('ACCESS_TOKEN: "reg-tok"');
    expect(yaml).toContain('CLAUDE_CODE_OAUTH_TOKEN: "clm-tok"');
  });

  it("sets RUNNER_SCOPE=repo and EPHEMERAL=true", () => {
    const yaml = renderComposeFile({
      ref,
      runnerCount: 1,
      registrationToken: "x",
      claudeToken: "y",
    });
    expect(yaml).toContain('RUNNER_SCOPE: "repo"');
    expect(yaml).toContain('EPHEMERAL: "true"');
  });

  it("throws ClawError on invalid runner count", () => {
    expect(() =>
      renderComposeFile({
        ref,
        runnerCount: 0,
        registrationToken: "x",
        claudeToken: "y",
      }),
    ).toThrow(ClawError);
    expect(() =>
      renderComposeFile({
        ref,
        runnerCount: 1.5,
        registrationToken: "x",
        claudeToken: "y",
      }),
    ).toThrow(ClawError);
  });

  it("is deterministic — same inputs produce byte-identical output", () => {
    const a = renderComposeFile({
      ref,
      runnerCount: 2,
      registrationToken: "r",
      claudeToken: "c",
    });
    const b = renderComposeFile({
      ref,
      runnerCount: 2,
      registrationToken: "r",
      claudeToken: "c",
    });
    expect(a).toBe(b);
  });
});

describe("generateRunnerComposeFile", () => {
  it("writes the compose file to disk via injected fs seam", async () => {
    const writes = new Map<string, string>();
    const mkdirs: string[] = [];
    await generateRunnerComposeFile({
      ref,
      runnerCount: 1,
      registrationToken: "r",
      claudeToken: "c",
      path: "/tmp/proj/.claw/runners/docker-compose.yml",
      fs: {
        writeFile: async (path, content) => {
          writes.set(path, content);
        },
        mkdir: async (path) => {
          mkdirs.push(path);
        },
      },
    });
    expect(writes.get("/tmp/proj/.claw/runners/docker-compose.yml")).toContain(
      "claw-runner-1:",
    );
    expect(mkdirs).toContain("/tmp/proj/.claw/runners");
  });

  it("chmods the compose file to 0600 (same as .claw/.env)", async () => {
    // The compose file embeds CLAUDE_CODE_OAUTH_TOKEN in plaintext, so it
    // must not be world-readable on multi-user systems. Matches the
    // writeEnvFile convention.
    const chmods: Array<{ path: string; mode: number }> = [];
    await generateRunnerComposeFile({
      ref,
      runnerCount: 1,
      registrationToken: "r",
      claudeToken: "c",
      path: "/tmp/proj/.claw/runners/docker-compose.yml",
      fs: {
        writeFile: async () => {},
        mkdir: async () => {},
        chmod: async (path, mode) => {
          chmods.push({ path, mode });
        },
      },
    });
    expect(chmods).toEqual([
      { path: "/tmp/proj/.claw/runners/docker-compose.yml", mode: 0o600 },
    ]);
  });

  it("tolerates chmod failure (Windows FAT compatibility)", async () => {
    // Same tolerance as writeEnvFile — a missing POSIX mode bit must not
    // fail the whole setup flow.
    await expect(
      generateRunnerComposeFile({
        ref,
        runnerCount: 1,
        registrationToken: "r",
        claudeToken: "c",
        path: "/tmp/proj/.claw/runners/docker-compose.yml",
        fs: {
          writeFile: async () => {},
          mkdir: async () => {},
          chmod: async () => {
            throw new Error("ENOSYS");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("lifts write errors into ClawError", async () => {
    await expect(
      generateRunnerComposeFile({
        ref,
        runnerCount: 1,
        registrationToken: "r",
        claudeToken: "c",
        path: "/invalid/path/docker-compose.yml",
        fs: {
          writeFile: async () => {
            throw new Error("EACCES");
          },
          mkdir: async () => {},
        },
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });
});

describe("requestRunnerRegistrationToken", () => {
  it("returns the token from a successful response", async () => {
    const octokit = {
      actions: {
        createRegistrationTokenForRepo: vi.fn(async () => ({
          data: { token: "ghr_xyz" },
        })),
      },
    } as unknown as Parameters<typeof requestRunnerRegistrationToken>[0]["octokit"];
    const token = await requestRunnerRegistrationToken({ ref, octokit });
    expect(token).toBe("ghr_xyz");
  });

  it("throws ClawError when the API fails", async () => {
    const octokit = {
      actions: {
        createRegistrationTokenForRepo: vi.fn(async () => {
          throw new Error("401");
        }),
      },
    } as unknown as Parameters<typeof requestRunnerRegistrationToken>[0]["octokit"];
    const error = await requestRunnerRegistrationToken({ ref, octokit }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
  });

  it("throws ClawError when the response has no token", async () => {
    const octokit = {
      actions: {
        createRegistrationTokenForRepo: vi.fn(async () => ({ data: {} })),
      },
    } as unknown as Parameters<typeof requestRunnerRegistrationToken>[0]["octokit"];
    await expect(
      requestRunnerRegistrationToken({ ref, octokit }),
    ).rejects.toBeInstanceOf(ClawError);
  });
});

describe("startRunners", () => {
  const composeFile = "/tmp/proj/.claw/runners/docker-compose.yml";
  const baseOctokit = {
    actions: {
      listSelfHostedRunnersForRepo: vi.fn(async () => ({
        data: { total_count: 0, runners: [] },
      })),
    },
  } as unknown as Parameters<typeof startRunners>[0]["octokit"];

  it("halts with a clear error when Docker is not available", async () => {
    const error = await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      deps: { dockerAvailable: async () => false },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("Docker is required");
  });

  it("calls composeUp with the compose file path", async () => {
    const composeUp = vi.fn(async () => {});
    await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      deps: {
        dockerAvailable: async () => true,
        composeUp,
        pollOnline: async () => true,
      },
    });
    expect(composeUp).toHaveBeenCalledWith(composeFile);
  });

  it("lifts compose failures into ClawError with a diagnostic hint", async () => {
    const error = await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      deps: {
        dockerAvailable: async () => true,
        composeUp: async () => {
          throw new Error("daemon not running");
        },
      },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("docker compose up -d");
    expect((error as ClawError).hint).toContain(composeFile);
  });

  it("returns immediately when a runner is online on the first poll", async () => {
    const pollOnline = vi.fn(async () => true);
    const sleep = vi.fn(async () => {});
    await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      deps: {
        dockerAvailable: async () => true,
        composeUp: async () => {},
        pollOnline,
        sleep,
      },
    });
    expect(pollOnline).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls until a runner comes online within the timeout", async () => {
    let calls = 0;
    const pollOnline = vi.fn(async () => {
      calls += 1;
      return calls >= 3;
    });
    const sleep = vi.fn(async () => {});
    let now = 0;
    await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      timeoutMs: 10_000,
      pollIntervalMs: 1_000,
      deps: {
        dockerAvailable: async () => true,
        composeUp: async () => {},
        pollOnline,
        sleep,
        now: () => {
          now += 1_000;
          return now;
        },
      },
    });
    expect(pollOnline).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws ClawError when the timeout elapses with no online runner", async () => {
    const pollOnline = vi.fn(async () => false);
    let now = 0;
    const error = await startRunners({
      ref,
      octokit: baseOctokit,
      composeFile,
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
      deps: {
        dockerAvailable: async () => true,
        composeUp: async () => {},
        pollOnline,
        sleep: async () => {},
        now: () => {
          now += 1_000;
          return now;
        },
      },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("runners did not come online");
    expect((error as ClawError).hint).toContain(composeFile);
  });
});
