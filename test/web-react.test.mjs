import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const reactSource = readFileSync(new URL("../src/web-react.tsx", import.meta.url), "utf8");

test("package exposes the /web/react React binding entry point", () => {
  assert.equal(packageJson.exports["./web/react"].types, "./dist/web-react.d.ts");
  assert.equal(packageJson.exports["./web/react"].import, "./dist/web-react.js");
});

test("web-react exports the provider + hook", () => {
  assert.match(reactSource, /export function SwigWebProvider/);
  assert.match(reactSource, /export const useSwigWeb/);
});

test("web-react does not import Expo or React Native modules", () => {
  assert.doesNotMatch(reactSource, /expo-/);
  assert.doesNotMatch(reactSource, /react-native/);
});

test("web-react renders a persistent, never-unmounted iframe surface", () => {
  // The container ref is rendered unconditionally; only styling toggles.
  assert.match(reactSource, /SwigConsentSurface/);
  assert.match(reactSource, /ref=\{containerRef\}/);
});

test("web-react pulls in no on-chain deps (roles are the consumer's job)", () => {
  // The SDK must stay web3.js-free; on-chain role reads live in the consuming
  // app (mirroring the native app), never in the SDK bundle.
  assert.doesNotMatch(reactSource, /@solana\/web3\.js/);
  assert.doesNotMatch(reactSource, /@swig-wallet\/classic/);
  assert.doesNotMatch(reactSource, /onchain|getOnChainRoles|fetchSwigRoles/);
});
