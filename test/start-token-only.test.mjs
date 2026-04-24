import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const startOAuthSource = readFileSync(
  new URL("../src/states/start-oauth.ts", import.meta.url),
  "utf8",
);

test("sdk start oauth flow requires start_token", () => {
  assert.match(startOAuthSource, /new URLSearchParams\(\{ start_token: startToken \}\)/);
  assert.match(startOAuthSource, /Backend did not return a start token/);
  assert.doesNotMatch(startOAuthSource, /oauth_redirect/);
  assert.doesNotMatch(startOAuthSource, /nonce/);
});
