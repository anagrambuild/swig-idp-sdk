import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const webSource = readFileSync(new URL("../src/web.ts", import.meta.url), "utf8");
const embeddedSource = readFileSync(
  new URL("../src/embedded.ts", import.meta.url),
  "utf8",
);
const sessionStoreSource = readFileSync(
  new URL("../src/swig-session/session-store.ts", import.meta.url),
  "utf8",
);
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
  assert.doesNotMatch(webSource, /secretKey/);
  assert.doesNotMatch(webSource, /privateKey/);
});

test("incoming isolated-host messages are bound to the exact origin and window", () => {
  // Origin is compared by exact parsed origin, never a prefix/startsWith match.
  assert.match(webSource, /new URL\(this\.isolatedHostUrl\)\.origin/);
  assert.doesNotMatch(webSource, /isolatedHostUrl\.startsWith/);
  // The proof-session listener (carries the zkProof) binds to the exact iframe.
  assert.match(webSource, /event\.source !== iframe\.contentWindow/);
  // waitForGrantAccessResult optionally binds to the caller-provided frame.
  assert.match(webSource, /input\.frame && event\.source !== input\.frame\.contentWindow/);
  // The retired proof-in-URL redirect path stays gone.
  assert.doesNotMatch(webSource, /parseProofSessionRefreshCallbackUrl/);
});

test("persisted requester authority stores the ProgramExec proof variant", () => {
  assert.match(sessionStoreSource, /export type SwigRequesterAuthority =/);
  assert.match(sessionStoreSource, /\| \{ programExecProof: \{ roleId: number; zkProof: string \} \}/);
  assert.match(sessionStoreSource, /requesterAuthority\?: SwigRequesterAuthority/);
  assert.doesNotMatch(sessionStoreSource, /ed25519\?:/);
  assert.doesNotMatch(sessionStoreSource, /programExecSession\?:/);
  assert.doesNotMatch(sessionStoreSource, /sessionKey/);
});

test("the web SDK bundle is free of heavy on-chain dependencies", () => {
  // @solana/web3.js + @swig-wallet/classic must not enter the /web or
  // /web/react bundle. On-chain role reads are the consuming app's job.
  for (const source of [webSource, embeddedSource]) {
    assert.doesNotMatch(source, /@solana\/web3\.js/);
    assert.doesNotMatch(source, /@swig-wallet\/classic/);
    assert.doesNotMatch(source, /onchain|fetchSwigRoles|getOnChainRoles/);
  }
  // And they are no longer declared as (optional) peers.
  assert.equal(packageJson.peerDependencies?.["@solana/web3.js"], undefined);
  assert.equal(packageJson.peerDependencies?.["@swig-wallet/classic"], undefined);
});

test("runtime peer dependencies are optional for web consumers", () => {
  assert.equal(packageJson.peerDependenciesMeta["expo-crypto"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-secure-store"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-web-browser"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta.react.optional, true);
  assert.equal(packageJson.peerDependenciesMeta["react-native"].optional, true);
});
