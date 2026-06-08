import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const webSource = readFileSync(new URL("../src/web.ts", import.meta.url), "utf8");
const revokeStartSource = webSource.slice(
  webSource.indexOf("async getRevokeAgentStartUrl"),
  webSource.indexOf("async redirectToRevokeAgent"),
);

test("package exposes a browser-safe web entry point", () => {
  assert.equal(packageJson.exports["./web"].types, "./dist/web.d.ts");
  assert.equal(packageJson.exports["./web"].import, "./dist/web.js");
  assert.match(webSource, /createSwigWebClient/);
  assert.match(webSource, /redirectToRevokeAgent/);
  assert.match(webSource, /completeAgentRevokeFromUrl/);
  assert.match(webSource, /ensureProofSession/);
  assert.match(webSource, /createSigner/);
});

test("agent revoke starts a direct isolated-host flow without provider auth", () => {
  assert.match(revokeStartSource, /\/agent\/revoke/);
  assert.match(revokeStartSource, /swig_pubkey/);
  assert.match(revokeStartSource, /role_id/);
  assert.doesNotMatch(revokeStartSource, /getOAuthStartUrl/);
  assert.doesNotMatch(revokeStartSource, /provider/);
});

test("web entry point does not import Expo or React Native modules", () => {
  assert.doesNotMatch(webSource, /expo-/);
  assert.doesNotMatch(webSource, /react-native/);
  assert.doesNotMatch(webSource, /from "\.\/provider"/);
  assert.doesNotMatch(webSource, /from "\.\/polyfills"/);
});

test("web session manager exposes top-level reauth and isolated-host signing boundaries", () => {
  assert.match(webSource, /SwigProofSessionReauthRequiredError/);
  assert.match(webSource, /getProofSessionRefreshUrl/);
  assert.match(webSource, /getTransactionSignUrl/);
  assert.match(webSource, /\/session\/refresh/);
  assert.match(webSource, /\/transaction\/sign/);
  assert.match(webSource, /swig:idp-transaction-sign-ready/);
  assert.match(webSource, /swig:idp-transaction-sign-result/);
  assert.doesNotMatch(webSource, /secretKey/);
  assert.doesNotMatch(webSource, /privateKey/);
});

test("runtime peer dependencies are optional for web consumers", () => {
  assert.equal(packageJson.peerDependenciesMeta["@swig-wallet/classic"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-crypto"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-secure-store"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-web-browser"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta.react.optional, true);
  assert.equal(packageJson.peerDependenciesMeta["react-native"].optional, true);
});
