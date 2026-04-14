import { describe, it, expect, vi } from "vitest";
import { hasOnlineRunner, listRunners } from "../../../src/core/setup/runners.js";
import { ClawError } from "../../../src/core/types/errors.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };

type Actions = Parameters<typeof listRunners>[0]["octokit"]["actions"];

function actionsStub(overrides: Partial<Actions>): { actions: Actions } {
  const actions = {
    listSelfHostedRunnersForRepo: vi.fn(async () => ({
      data: {
        total_count: 0,
        runners: [],
      },
    })),
    ...overrides,
  } as unknown as Actions;
  return { actions };
}

describe("listRunners", () => {
  it("projects the Octokit response into a RunnerSummary", async () => {
    const { actions } = actionsStub({
      listSelfHostedRunnersForRepo: vi.fn(async () => ({
        data: {
          total_count: 2,
          runners: [
            { name: "runner-a", status: "online", busy: false },
            { name: "runner-b", status: "offline", busy: true },
          ],
        },
      })) as unknown as Actions["listSelfHostedRunnersForRepo"],
    });

    const result = await listRunners({ ref, octokit: { actions } });
    expect(result).toEqual([
      { name: "runner-a", online: true, idle: true },
      { name: "runner-b", online: false, idle: false },
    ]);
  });

  it("returns [] when the API reports no runners", async () => {
    const { actions } = actionsStub({});
    const result = await listRunners({ ref, octokit: { actions } });
    expect(result).toEqual([]);
  });

  it("throws ClawError when the API call fails", async () => {
    const { actions } = actionsStub({
      listSelfHostedRunnersForRepo: vi.fn(async () => {
        throw new Error("403");
      }) as unknown as Actions["listSelfHostedRunnersForRepo"],
    });

    const error = await listRunners({ ref, octokit: { actions } }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).hint).toContain("admin access");
  });
});

describe("hasOnlineRunner", () => {
  it("returns true when at least one runner is online (even if busy)", async () => {
    const { actions } = actionsStub({
      listSelfHostedRunnersForRepo: vi.fn(async () => ({
        data: {
          total_count: 1,
          runners: [{ name: "busy-online", status: "online", busy: true }],
        },
      })) as unknown as Actions["listSelfHostedRunnersForRepo"],
    });
    await expect(hasOnlineRunner({ ref, octokit: { actions } })).resolves.toBe(true);
  });

  it("returns false when every runner is offline", async () => {
    const { actions } = actionsStub({
      listSelfHostedRunnersForRepo: vi.fn(async () => ({
        data: {
          total_count: 2,
          runners: [
            { name: "a", status: "offline", busy: false },
            { name: "b", status: "offline", busy: false },
          ],
        },
      })) as unknown as Actions["listSelfHostedRunnersForRepo"],
    });
    await expect(hasOnlineRunner({ ref, octokit: { actions } })).resolves.toBe(false);
  });
});
