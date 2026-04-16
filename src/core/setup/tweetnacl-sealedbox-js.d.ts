/**
 * Minimal ambient type declaration for `tweetnacl-sealedbox-js`.
 *
 * The upstream package ships no `.d.ts`. We type only the two functions
 * we actually use so a future upstream change cannot silently drift the
 * typed contract away from the runtime behaviour.
 */
declare module "tweetnacl-sealedbox-js" {
  /** Seal `message` for the recipient identified by `publicKey`. */
  export function seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  /** Open a sealed box addressed to the (publicKey, secretKey) pair. */
  export function open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array,
  ): Uint8Array | null;
  /** Total overhead (ephemeral public key + box overhead) added by {@link seal}. */
  export const overheadLength: number;
  const sealedbox: {
    seal: typeof seal;
    open: typeof open;
  };
  export default sealedbox;
}
