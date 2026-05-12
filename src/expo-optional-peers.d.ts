declare module "expo-crypto" {
  export enum CryptoDigestAlgorithm {
    SHA256 = "SHA-256",
    SHA384 = "SHA-384",
    SHA512 = "SHA-512",
  }

  export function digest(
    algorithm: CryptoDigestAlgorithm,
    data: ArrayBuffer,
  ): Promise<ArrayBuffer>;
}

declare module "expo-web-browser" {
  export type WebBrowserAuthSessionResult =
    | { type: "success"; url: string }
    | { type: "cancel" | "dismiss" | "locked" };

  export function openAuthSessionAsync(
    url: string,
    redirectUrl?: string,
  ): Promise<WebBrowserAuthSessionResult>;
}
