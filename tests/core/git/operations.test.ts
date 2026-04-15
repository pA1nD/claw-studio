import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import {
  branchName,
  buildSquashCommitMessage,
  buildSquashCommitTitle,
  createBranch,
  deleteBranch,
  GitConflictError,
  isGitConflictError,
  isMergeConflictError,
  mergeDefaultIntoBranch,
  rebaseOnDefault,
  squashMerge,
} from "../../../src/core/git/operations.js";
import type {
  CreateBranchDeps,
  DeleteBranchDeps,
  MergeDefaultIntoBranchDeps,
  RebaseOnDefaultDeps,
  SquashMergeDeps,
} from "../../../src/core/git/operations.js";
import { ClawError } from "../../../src/core/types/errors.js";

const stubClient = {} as Octokit;
const REPO = "pA1nD/claw-studio";
const DEFAULT_BRANCH = "main";
const DEFAULT_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLAW_BRANCH = "claw/issue-6-git-strategy";

/**
 * Build an Octokit-shaped error object the rate-limit + conflict detectors
 * will recognise. Mirrors the helper in `rate-limit.test.ts`.
 */
function octokitError(
  status: number,
  extras: { message?: string; headers?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    status,
    message: extras.message,
    response: { headers: extras.headers ?? {} },
  };
}

describe("branchName re-export", () => {
  it("is the same function as the canonical agent helper", () => {
    expect(branchName(6, "Git strategy")).toBe("claw/issue-6-git-strategy");
  });

  it("produces the exact format documented in the issue", () => {
    expect(branchName(14, "GitHub auth")).toBe("claw/issue-14-github-auth");
    expect(branchName(3, "Implementation agent")).toBe(
      "claw/issue-3-implementation-agent",
    );
  });
});

describe("buildSquashCommitTitle", () => {
  it("produces the exact format `feat: {title} (closes #{N})`", () => {
    expect(buildSquashCommitTitle("Git strategy", 6)).toBe(
      "feat: Git strategy (closes #6)",
    );
  });

  it("trims surrounding whitespace from the issue title", () => {
    expect(buildSquashCommitTitle("  Git strategy \n", 6)).toBe(
      "feat: Git strategy (closes #6)",
    );
  });

  it("preserves inner punctuation the issue title contains", () => {
    expect(
      buildSquashCommitTitle("Git strategy — branch lifecycle, rebase", 6),
    ).toBe("feat: Git strategy — branch lifecycle, rebase (closes #6)");
  });
});

describe("buildSquashCommitMessage", () => {
  it("contains the `Closes #{N}` auto-close token", () => {
    expect(buildSquashCommitMessage(6)).toBe("Closes #6\n");
  });
});

describe("GitConflictError", () => {
  it("extends ClawError so the standard error renderer works", () => {
    const err = new GitConflictError("rebase", CLAW_BRANCH);
    expect(err).toBeInstanceOf(ClawError);
    expect(err).toBeInstanceOf(GitConflictError);
    expect(err.name).toBe("GitConflictError");
  });

  it("formats the standard two-line error message", () => {
    const err = new GitConflictError("merge", CLAW_BRANCH);
    expect(err.message).toBe(
      "merge hit conflicts on claw/issue-6-git-strategy.",
    );
    expect(err.hint).toContain("needs-human");
  });

  it("records the operation and branch fields", () => {
    const err = new GitConflictError("rebase", CLAW_BRANCH);
    expect(err.operation).toBe("rebase");
    expect(err.branch).toBe(CLAW_BRANCH);
  });
});

describe("isGitConflictError", () => {
  it("accepts GitConflictError instances", () => {
    expect(isGitConflictError(new GitConflictError("merge", CLAW_BRANCH))).toBe(
      true,
    );
  });

  it("rejects plain ClawErrors (conflicts are a narrower subclass)", () => {
    expect(isGitConflictError(new ClawError("rate limit."))).toBe(false);
  });

  it("rejects non-error values", () => {
    expect(isGitConflictError(null)).toBe(false);
    expect(isGitConflictError("conflict")).toBe(false);
    expect(isGitConflictError({ message: "conflict" })).toBe(false);
  });
});

describe("isMergeConflictError", () => {
  it("matches HTTP 409 regardless of message body", () => {
    expect(isMergeConflictError(octokitError(409))).toBe(true);
    expect(
      isMergeConflictError(octokitError(409, { message: "Merge conflict" })),
    ).toBe(true);
  });

  it("matches HTTP 422 when the message body says 'conflict'", () => {
    expect(
      isMergeConflictError(
        octokitError(422, { message: "Merge conflict detected" }),
      ),
    ).toBe(true);
    // Case-insensitive on the "conflict" keyword.
    expect(
      isMergeConflictError(octokitError(422, { message: "CONFLICT" })),
    ).toBe(true);
  });

  it("rejects HTTP 422 when the message body is something else", () => {
    expect(
      isMergeConflictError(
        octokitError(422, { message: "Validation Failed" }),
      ),
    ).toBe(false);
  });

  it("rejects unrelated statuses and non-objects", () => {
    expect(isMergeConflictError(octokitError(404))).toBe(false);
    expect(isMergeConflictError(octokitError(500))).toBe(false);
    expect(isMergeConflictError(new Error("boom"))).toBe(false);
    expect(isMergeConflictError(null)).toBe(false);
    expect(isMergeConflictError(undefined)).toBe(false);
    expect(isMergeConflictError("conflict")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createBranch
// ---------------------------------------------------------------------------

describe("createBranch", () => {
  function deps(
    overrides: Partial<CreateBranchDeps> = {},
  ): CreateBranchDeps {
    return {
      readDefaultBranchHead:
        overrides.readDefaultBranchHead ??
        vi.fn(async () => ({ name: DEFAULT_BRANCH, sha: DEFAULT_SHA })),
      createRef: overrides.createRef ?? vi.fn(async () => {}),
    };
  }

  it("creates a ref at refs/heads/{branch} pointing at the default-branch tip", async () => {
    const createRef = vi.fn(async () => {});
    await createBranch(stubClient, REPO, CLAW_BRANCH, deps({ createRef }));

    expect(createRef).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      `refs/heads/${CLAW_BRANCH}`,
      DEFAULT_SHA,
    );
  });

  it("rejects a branch that is not claw-prefixed without calling GitHub", async () => {
    const readHead = vi.fn(async () => ({ name: "main", sha: "x" }));
    const createRef = vi.fn(async () => {});

    await expect(
      createBranch(stubClient, REPO, "feature/rogue", {
        readDefaultBranchHead: readHead,
        createRef,
      }),
    ).rejects.toMatchObject({
      message: "refusing to operate on non-claw branch feature/rogue.",
    });

    expect(readHead).not.toHaveBeenCalled();
    expect(createRef).not.toHaveBeenCalled();
  });

  it("rejects an invalid --repo string before any network call", async () => {
    const readHead = vi.fn(async () => ({ name: "main", sha: "x" }));
    await expect(
      createBranch(stubClient, "not-a-repo", CLAW_BRANCH, {
        readDefaultBranchHead: readHead,
      }),
    ).rejects.toMatchObject({ message: "invalid --repo value." });
    expect(readHead).not.toHaveBeenCalled();
  });

  it("translates rate-limit errors into the standard ClawError", async () => {
    await expect(
      createBranch(stubClient, REPO, CLAW_BRANCH, {
        readDefaultBranchHead: async () => {
          throw octokitError(429);
        },
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    const err = new Error("disk full");
    await expect(
      createBranch(stubClient, REPO, CLAW_BRANCH, {
        readDefaultBranchHead: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// rebaseOnDefault
// ---------------------------------------------------------------------------

describe("rebaseOnDefault", () => {
  function deps(
    overrides: Partial<RebaseOnDefaultDeps> = {},
  ): RebaseOnDefaultDeps {
    return {
      findOpenPullNumberForBranch:
        overrides.findOpenPullNumberForBranch ?? vi.fn(async () => 42),
      updatePullRequestBranch:
        overrides.updatePullRequestBranch ?? vi.fn(async () => {}),
    };
  }

  it("looks up the PR for the branch and calls update-branch", async () => {
    const findPr = vi.fn(async () => 42);
    const update = vi.fn(async () => {});

    await rebaseOnDefault(
      stubClient,
      REPO,
      CLAW_BRANCH,
      deps({
        findOpenPullNumberForBranch: findPr,
        updatePullRequestBranch: update,
      }),
    );

    expect(findPr).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      CLAW_BRANCH,
    );
    expect(update).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      42,
    );
  });

  it("throws a ClawError when no open PR exists for the branch", async () => {
    const update = vi.fn(async () => {});
    await expect(
      rebaseOnDefault(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          findOpenPullNumberForBranch: async () => null,
          updatePullRequestBranch: update,
        }),
      ),
    ).rejects.toMatchObject({
      message: `no open PR found for branch ${CLAW_BRANCH}.`,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("translates a 422 merge conflict into GitConflictError", async () => {
    await expect(
      rebaseOnDefault(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          updatePullRequestBranch: async () => {
            throw octokitError(422, { message: "Merge conflict" });
          },
        }),
      ),
    ).rejects.toThrow(GitConflictError);
  });

  it("carries the branch + operation on the thrown GitConflictError", async () => {
    try {
      await rebaseOnDefault(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          updatePullRequestBranch: async () => {
            throw octokitError(422, { message: "Merge conflict" });
          },
        }),
      );
      throw new Error("expected GitConflictError to be thrown");
    } catch (err) {
      expect(isGitConflictError(err)).toBe(true);
      if (isGitConflictError(err)) {
        expect(err.operation).toBe("rebase");
        expect(err.branch).toBe(CLAW_BRANCH);
      }
    }
  });

  it("propagates non-conflict 422s unchanged (not every 422 is a conflict)", async () => {
    const err = octokitError(422, { message: "Validation Failed" });
    await expect(
      rebaseOnDefault(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          updatePullRequestBranch: async () => {
            throw err;
          },
        }),
      ),
    ).rejects.toBe(err);
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    // Generic (non-Octokit-shaped) error — mirrors the propagation test every
    // other public function carries, so the rate-limit wrapper's pass-through
    // path is pinned identically across the module.
    const err = new Error("network timeout");
    await expect(
      rebaseOnDefault(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          updatePullRequestBranch: async () => {
            throw err;
          },
        }),
      ),
    ).rejects.toBe(err);
  });

  it("rejects a non-claw branch without looking up a PR", async () => {
    const findPr = vi.fn(async () => 42);
    await expect(
      rebaseOnDefault(stubClient, REPO, "feature/rogue", {
        findOpenPullNumberForBranch: findPr,
      }),
    ).rejects.toMatchObject({
      message: "refusing to operate on non-claw branch feature/rogue.",
    });
    expect(findPr).not.toHaveBeenCalled();
  });

  it("translates rate-limit errors into the standard ClawError", async () => {
    await expect(
      rebaseOnDefault(stubClient, REPO, CLAW_BRANCH, {
        findOpenPullNumberForBranch: async () => {
          throw octokitError(403, { headers: { "x-ratelimit-remaining": "0" } });
        },
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });
});

// ---------------------------------------------------------------------------
// mergeDefaultIntoBranch
// ---------------------------------------------------------------------------

describe("mergeDefaultIntoBranch", () => {
  function deps(
    overrides: Partial<MergeDefaultIntoBranchDeps> = {},
  ): MergeDefaultIntoBranchDeps {
    return {
      readDefaultBranchName:
        overrides.readDefaultBranchName ?? vi.fn(async () => DEFAULT_BRANCH),
      mergeRefs: overrides.mergeRefs ?? vi.fn(async () => {}),
    };
  }

  it("merges the default branch into the claw branch", async () => {
    const merge = vi.fn(async () => {});

    await mergeDefaultIntoBranch(
      stubClient,
      REPO,
      CLAW_BRANCH,
      deps({ mergeRefs: merge }),
    );

    expect(merge).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      CLAW_BRANCH,
      DEFAULT_BRANCH,
    );
  });

  it("resolves on a 204 'already merged' response (seam returns void)", async () => {
    const merge = vi.fn(async () => {});
    await expect(
      mergeDefaultIntoBranch(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({ mergeRefs: merge }),
      ),
    ).resolves.toBeUndefined();
  });

  it("translates a 409 conflict into GitConflictError with operation 'merge'", async () => {
    try {
      await mergeDefaultIntoBranch(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          mergeRefs: async () => {
            throw octokitError(409);
          },
        }),
      );
      throw new Error("expected GitConflictError to be thrown");
    } catch (err) {
      expect(isGitConflictError(err)).toBe(true);
      if (isGitConflictError(err)) {
        expect(err.operation).toBe("merge");
        expect(err.branch).toBe(CLAW_BRANCH);
      }
    }
  });

  it("propagates unrelated errors unchanged", async () => {
    const err = new Error("disk full");
    await expect(
      mergeDefaultIntoBranch(
        stubClient,
        REPO,
        CLAW_BRANCH,
        deps({
          mergeRefs: async () => {
            throw err;
          },
        }),
      ),
    ).rejects.toBe(err);
  });

  it("rejects a non-claw branch without reading the default branch", async () => {
    const readDefault = vi.fn(async () => DEFAULT_BRANCH);
    await expect(
      mergeDefaultIntoBranch(stubClient, REPO, "feature/rogue", {
        readDefaultBranchName: readDefault,
      }),
    ).rejects.toMatchObject({
      message: "refusing to operate on non-claw branch feature/rogue.",
    });
    expect(readDefault).not.toHaveBeenCalled();
  });

  it("translates rate-limit errors into the standard ClawError", async () => {
    await expect(
      mergeDefaultIntoBranch(stubClient, REPO, CLAW_BRANCH, {
        readDefaultBranchName: async () => {
          throw octokitError(429);
        },
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });
});

// ---------------------------------------------------------------------------
// squashMerge
// ---------------------------------------------------------------------------

describe("squashMerge", () => {
  function deps(overrides: Partial<SquashMergeDeps> = {}): SquashMergeDeps {
    return {
      mergePullRequest:
        overrides.mergePullRequest ??
        vi.fn(async () => ({ sha: "merged-sha" })),
    };
  }

  it("calls the merge seam with the exact commit title format", async () => {
    const mergePR = vi.fn(async () => ({ sha: "abc" }));

    await squashMerge(
      stubClient,
      REPO,
      42,
      "Git strategy",
      6,
      deps({ mergePullRequest: mergePR }),
    );

    expect(mergePR).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      42,
      "feat: Git strategy (closes #6)",
      "Closes #6\n",
    );
  });

  it("returns the SHA of the new commit on the default branch", async () => {
    const result = await squashMerge(
      stubClient,
      REPO,
      42,
      "Git strategy",
      6,
      deps({
        mergePullRequest: async () => ({ sha: "merged-sha" }),
      }),
    );
    expect(result).toEqual({ sha: "merged-sha" });
  });

  it("rejects an invalid --repo string before any merge call", async () => {
    const mergePR = vi.fn(async () => ({ sha: "abc" }));
    await expect(
      squashMerge(stubClient, "not-a-repo", 42, "title", 6, {
        mergePullRequest: mergePR,
      }),
    ).rejects.toMatchObject({ message: "invalid --repo value." });
    expect(mergePR).not.toHaveBeenCalled();
  });

  it("translates rate-limit errors into the standard ClawError", async () => {
    await expect(
      squashMerge(stubClient, REPO, 42, "title", 6, {
        mergePullRequest: async () => {
          throw octokitError(429);
        },
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });

  it("propagates non-rate-limit merge failures unchanged", async () => {
    const err = new Error("merge refused");
    await expect(
      squashMerge(stubClient, REPO, 42, "title", 6, {
        mergePullRequest: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// deleteBranch
// ---------------------------------------------------------------------------

describe("deleteBranch", () => {
  function deps(overrides: Partial<DeleteBranchDeps> = {}): DeleteBranchDeps {
    return {
      deleteRef: overrides.deleteRef ?? vi.fn(async () => {}),
    };
  }

  it("deletes the heads/{branch} ref on the target repo", async () => {
    const del = vi.fn(async () => {});
    await deleteBranch(stubClient, REPO, CLAW_BRANCH, deps({ deleteRef: del }));
    expect(del).toHaveBeenCalledWith(
      { owner: "pA1nD", repo: "claw-studio" },
      `heads/${CLAW_BRANCH}`,
    );
  });

  it("refuses to delete a branch that is not claw-prefixed", async () => {
    const del = vi.fn(async () => {});
    await expect(
      deleteBranch(stubClient, REPO, "main", { deleteRef: del }),
    ).rejects.toMatchObject({
      message: "refusing to operate on non-claw branch main.",
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("refuses to delete a feature/ branch", async () => {
    const del = vi.fn(async () => {});
    await expect(
      deleteBranch(stubClient, REPO, "feature/whatever", { deleteRef: del }),
    ).rejects.toMatchObject({
      message: "refusing to operate on non-claw branch feature/whatever.",
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("translates rate-limit errors into the standard ClawError", async () => {
    await expect(
      deleteBranch(stubClient, REPO, CLAW_BRANCH, {
        deleteRef: async () => {
          throw octokitError(429);
        },
      }),
    ).rejects.toMatchObject({
      message: "GitHub API rate limit reached.",
    });
  });

  it("propagates non-rate-limit errors unchanged", async () => {
    const err = new Error("permission denied");
    await expect(
      deleteBranch(stubClient, REPO, CLAW_BRANCH, {
        deleteRef: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});
