import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  encryptSecret,
  getRepoPublicKey,
  pushRepoActionsSecret,
} from "../../../src/core/setup/secret.js";
import { ClawError } from "../../../src/core/types/errors.js";

const ref = { owner: "pA1nD", repo: "claw-studio" };

type Actions = Parameters<typeof pushRepoActionsSecret>[0]["octokit"]["actions"];

function actionsStub(overrides: Partial<Actions> = {}): {
  actions: Actions;
  calls: {
    createOrUpdateRepoSecret: Array<{
      secret_name: string;
      encrypted_value: string;
      key_id: string;
    }>;
  };
} {
  const calls = {
    createOrUpdateRepoSecret: [] as Array<{
      secret_name: string;
      encrypted_value: string;
      key_id: string;
    }>,
  };
  const actions = {
    getRepoPublicKey: vi.fn(async () => ({
      data: { key: "dGVzdC1wdWJsaWMta2V5", key_id: "k-1" },
    })),
    createOrUpdateRepoSecret: vi.fn(async (args: Record<string, unknown>) => {
      calls.createOrUpdateRepoSecret.push({
        secret_name: String(args["secret_name"]),
        encrypted_value: String(args["encrypted_value"]),
        key_id: String(args["key_id"]),
      });
      return { data: {} };
    }),
    ...overrides,
  } as unknown as Actions;
  return { actions, calls };
}

describe("encryptSecret", () => {
  it("returns base64-encoded output of non-trivial length", async () => {
    const value = "a-secret-value";
    // 32-byte Curve25519 public key, base64-encoded.
    const publicKey = Buffer.alloc(32, 1).toString("base64");
    const out = await encryptSecret(value, publicKey);
    // Base64 output is at least as long as the input + sealed-box overhead
    // (~48 bytes), so the output must be strictly longer than the input.
    expect(out.length).toBeGreaterThan(value.length);
    // Round-trip through base64 must succeed.
    expect(() => Buffer.from(out, "base64")).not.toThrow();
  });

  it("produces ciphertext shorter than the plaintext is impossible", async () => {
    const publicKey = Buffer.alloc(32, 2).toString("base64");
    const short = await encryptSecret("x", publicKey);
    const decoded = Buffer.from(short, "base64");
    // Sealed box overhead is an ephemeral public key (32 bytes) + MAC (16 bytes).
    expect(decoded.length).toBeGreaterThanOrEqual(32 + 16 + 1);
  });

  it("is non-deterministic across invocations (ephemeral key)", async () => {
    const publicKey = Buffer.alloc(32, 3).toString("base64");
    const a = await encryptSecret("same", publicKey);
    const b = await encryptSecret("same", publicKey);
    // Sealed box generates an ephemeral keypair, so repeated encryption of
    // the same plaintext must produce different ciphertext.
    expect(a).not.toBe(b);
  });
});

describe("getRepoPublicKey", () => {
  it("projects the Octokit response", async () => {
    const { actions } = actionsStub();
    const result = await getRepoPublicKey({ ref, octokit: { actions } });
    expect(result).toEqual({ key: "dGVzdC1wdWJsaWMta2V5", key_id: "k-1" });
  });

  it("lifts API failures into ClawError", async () => {
    const { actions } = actionsStub({
      getRepoPublicKey: vi.fn(async () => {
        throw new Error("403 Forbidden");
      }) as unknown as Actions["getRepoPublicKey"],
    });
    const error = await getRepoPublicKey({ ref, octokit: { actions } }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).hint).toContain("admin access");
  });
});

describe("pushRepoActionsSecret", () => {
  it("encrypts and uploads with the right name and key_id", async () => {
    const { actions, calls } = actionsStub();
    await pushRepoActionsSecret({
      ref,
      octokit: { actions },
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "clm_token",
      deps: { encrypt: async (v) => `enc(${v})` },
    });
    expect(calls.createOrUpdateRepoSecret).toEqual([
      {
        secret_name: "CLAUDE_CODE_OAUTH_TOKEN",
        encrypted_value: "enc(clm_token)",
        key_id: "k-1",
      },
    ]);
  });

  it("throws ClawError when the value is empty", async () => {
    const { actions } = actionsStub();
    await expect(
      pushRepoActionsSecret({
        ref,
        octokit: { actions },
        name: "X",
        value: "",
      }),
    ).rejects.toBeInstanceOf(ClawError);
  });

  it("throws ClawError when the API PUT fails", async () => {
    const { actions } = actionsStub({
      createOrUpdateRepoSecret: vi.fn(async () => {
        throw new Error("422");
      }) as unknown as Actions["createOrUpdateRepoSecret"],
    });
    const error = await pushRepoActionsSecret({
      ref,
      octokit: { actions },
      name: "X",
      value: "v",
      deps: { encrypt: async () => "enc" },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).toContain("could not push secret X");
  });

  it("throws ClawError when the public-key fetch fails", async () => {
    const { actions } = actionsStub({
      getRepoPublicKey: vi.fn(async () => {
        throw new Error("403");
      }) as unknown as Actions["getRepoPublicKey"],
    });
    const error = await pushRepoActionsSecret({
      ref,
      octokit: { actions },
      name: "X",
      value: "v",
      deps: { encrypt: async () => "enc" },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
  });

  it("does not leak the plaintext secret in error messages", async () => {
    const { actions } = actionsStub({
      createOrUpdateRepoSecret: vi.fn(async () => {
        throw new Error("422");
      }) as unknown as Actions["createOrUpdateRepoSecret"],
    });
    const error = await pushRepoActionsSecret({
      ref,
      octokit: { actions },
      name: "X",
      value: "ghp_super_secret",
      deps: { encrypt: async () => "enc" },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ClawError);
    expect((error as ClawError).message).not.toContain("ghp_super_secret");
    expect((error as ClawError).hint ?? "").not.toContain("ghp_super_secret");
  });
});
