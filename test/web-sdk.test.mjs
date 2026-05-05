import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const webSource = readFileSync(new URL("../src/web.ts", import.meta.url), "utf8");

test("package exposes a browser-safe web entry point", () => {
  assert.equal(packageJson.exports["./web"].types, "./dist/web.d.ts");
  assert.equal(packageJson.exports["./web"].import, "./dist/web.js");
  assert.match(webSource, /createSwigWebClient/);
});

test("web entry point does not import Expo or React Native modules", () => {
  assert.doesNotMatch(webSource, /expo-/);
  assert.doesNotMatch(webSource, /react-native/);
  assert.doesNotMatch(webSource, /from "\.\/provider"/);
  assert.doesNotMatch(webSource, /from "\.\/polyfills"/);
});

test("runtime peer dependencies are optional for web consumers", () => {
  assert.equal(packageJson.peerDependenciesMeta["@swig-wallet/classic"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-crypto"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-secure-store"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta["expo-web-browser"].optional, true);
  assert.equal(packageJson.peerDependenciesMeta.react.optional, true);
  assert.equal(packageJson.peerDependenciesMeta["react-native"].optional, true);
});
