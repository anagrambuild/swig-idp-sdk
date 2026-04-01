/**
 * Solana network enum matching the proto `common.v1.Network` values.
 *
 * Usage:
 *   import { Network } from "@swig-wallet/expo-idp-sdk";
 *   startOAuth({ ..., network: Network.Devnet });
 */
export const Network = {
  Devnet: 1,
  Mainnet: 2,
} as const;

export type NetworkValue = (typeof Network)[keyof typeof Network];
