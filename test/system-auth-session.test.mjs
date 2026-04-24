import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const startOAuthSource = readFileSync(
  new URL("../src/states/start-oauth.ts", import.meta.url),
  "utf8",
);

test("sdk mobile auth uses a system auth session, not an embedded webview", () => {
  assert.match(startOAuthSource, /import \{ openAuthSessionAsync \} from "expo-web-browser"/);
  assert.match(startOAuthSource, /openAuthSessionAsync\(ihStartUrl, redirectUri\)/);
  assert.doesNotMatch(startOAuthSource, /react-native-webview/);
  assert.doesNotMatch(startOAuthSource, /<WebView\b/);
});
