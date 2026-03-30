/**
 * Polyfills for React Native compatibility with @solana/kit (Solana SDK v2).
 *
 * @solana/kit uses `crypto.subtle.digest()` for PDA derivation, which is not
 * available in React Native. This module bridges `expo-crypto` to provide it.
 *
 * Must be imported before any @swig-wallet/classic or @solana/kit usage.
 */
import { digest as expoCryptoDigest, CryptoDigestAlgorithm } from "expo-crypto";

if (typeof globalThis.isSecureContext === "undefined") {
  (globalThis as unknown as Record<string, unknown>).isSecureContext = true;
}

if (!globalThis.crypto?.subtle) {
  const ALGO_MAP: Record<string, CryptoDigestAlgorithm> = {
    "SHA-256": CryptoDigestAlgorithm.SHA256,
    "SHA-384": CryptoDigestAlgorithm.SHA384,
    "SHA-512": CryptoDigestAlgorithm.SHA512,
    SHA256: CryptoDigestAlgorithm.SHA256,
    SHA384: CryptoDigestAlgorithm.SHA384,
    SHA512: CryptoDigestAlgorithm.SHA512,
  };
  const subtle = {
    digest: async (
      algorithm: string | { name: string },
      data: ArrayBuffer,
    ): Promise<ArrayBuffer> => {
      const name = typeof algorithm === "string" ? algorithm : algorithm.name;
      const algo = ALGO_MAP[name] ?? CryptoDigestAlgorithm.SHA256;
      return expoCryptoDigest(algo, data);
    },
  };
  if (!globalThis.crypto)
    (globalThis as unknown as Record<string, unknown>).crypto = {};
  (globalThis.crypto as unknown as Record<string, unknown>).subtle = subtle;
}
