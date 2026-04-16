import { Buffer } from "node:buffer";
import sealedbox from "tweetnacl-sealedbox-js";
import type { Octokit } from "@octokit/rest";
import { ClawError } from "../types/errors.js";
import type { RepoRef } from "../github/repo-detect.js";

/** The repo-level public key returned by the Actions API. */
export interface RepoPublicKey {
  /** Base64-encoded Curve25519 public key. */
  key: string;
  /** Opaque identifier GitHub uses to version the key — required when pushing secrets. */
  key_id: string;
}

/** Options for {@link pushRepoActionsSecret}. */
export interface PushRepoActionsSecretOptions {
  /** Target repository. */
  ref: RepoRef;
  /** Authenticated Octokit (must come from `createClient()`). */
  octokit: Pick<Octokit, "actions">;
  /** Secret name — e.g. `CLAUDE_CODE_OAUTH_TOKEN`. */
  name: string;
  /** Plaintext secret value. Encrypted in-process before upload. */
  value: string;
  /** Injected seams for testing — lets tests bypass the sealed-box and Octokit. */
  deps?: PushRepoActionsSecretDeps;
}

/** Injectable seams so encryption and API calls can be exercised independently. */
export interface PushRepoActionsSecretDeps {
  /** Encrypt `value` with `publicKey` — defaults to {@link encryptSecret}. */
  encrypt?: (value: string, publicKey: string) => Promise<string>;
}

/**
 * Encrypt a secret value using libsodium's sealed-box construction — the
 * scheme GitHub's Actions-secret API requires. Returns base64 ciphertext
 * because that is what the API accepts as `encrypted_value`.
 *
 * The implementation uses `tweetnacl-sealedbox-js`, which is a minimal
 * pure-JS port of `crypto_box_seal`: generates an ephemeral keypair,
 * derives the nonce via BLAKE2b over the two public keys, and packs
 * `ephemeralPublicKey || ciphertext`. The wire format is byte-compatible
 * with libsodium.
 *
 * @param value     plaintext secret (e.g. a Claude Code OAuth token)
 * @param publicKey base64 Curve25519 public key from `getRepoPublicKey`
 * @returns base64-encoded sealed-box ciphertext
 */
export async function encryptSecret(
  value: string,
  publicKey: string,
): Promise<string> {
  const keyBytes = Buffer.from(publicKey, "base64");
  const messageBytes = Buffer.from(value, "utf8");
  const ciphertext = sealedbox.seal(
    new Uint8Array(messageBytes),
    new Uint8Array(keyBytes),
  );
  return Buffer.from(ciphertext).toString("base64");
}

/**
 * Fetch the repo's GitHub Actions public key — required before any Actions
 * secret can be uploaded.
 *
 * @param options ref + octokit
 * @returns the base64 key and its key_id
 * @throws {ClawError} when the API call fails
 */
export async function getRepoPublicKey(options: {
  ref: RepoRef;
  octokit: Pick<Octokit, "actions">;
}): Promise<RepoPublicKey> {
  const { ref, octokit } = options;
  try {
    const { data } = await octokit.actions.getRepoPublicKey({
      owner: ref.owner,
      repo: ref.repo,
    });
    return { key: data.key, key_id: data.key_id };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not read the Actions public key for ${ref.owner}/${ref.repo}.`,
      `Check that your PAT has admin access to the repo. Underlying error: ${detail}`,
    );
  }
}

/**
 * Push an Actions-level secret to a repo.
 *
 * Flow:
 *   1. Fetch the repo's public key.
 *   2. Encrypt the plaintext with the sealed-box construction (or the
 *      injected encryptor in tests).
 *   3. PUT `/repos/{owner}/{repo}/actions/secrets/{name}` with the
 *      base64 ciphertext and `key_id`.
 *
 * This replaces the `walkTokenStep` interactive hook: the human no longer
 * opens a browser to paste the token into the GitHub UI.
 *
 * @param options ref + octokit + name + value + optional deps
 * @throws {ClawError} when the public key cannot be read, encryption fails, or the PUT fails
 */
export async function pushRepoActionsSecret(
  options: PushRepoActionsSecretOptions,
): Promise<void> {
  const { ref, octokit, name, value } = options;
  const encrypt = options.deps?.encrypt ?? encryptSecret;

  if (value.length === 0) {
    throw new ClawError(
      `cannot push an empty value for ${name}.`,
      "Resolve the token via env var, flag, or .claw/.env before pushing secrets.",
    );
  }

  const publicKey = await getRepoPublicKey({ ref, octokit });
  const encrypted = await encrypt(value, publicKey.key);

  try {
    await octokit.actions.createOrUpdateRepoSecret({
      owner: ref.owner,
      repo: ref.repo,
      secret_name: name,
      encrypted_value: encrypted,
      key_id: publicKey.key_id,
    });
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ClawError(
      `could not push secret ${name} to ${ref.owner}/${ref.repo}.`,
      `Check that your PAT has admin access to the repo. Underlying error: ${detail}`,
    );
  }
}
