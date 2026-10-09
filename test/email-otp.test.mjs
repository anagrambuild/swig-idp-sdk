import assert from "node:assert/strict";
import test from "node:test";
import { EmailOtpClient, EmailOtpError } from "../dist/email-otp.js";

const input = { email: "user@example.test", clientId: "client", oidcNonce: "server-nonce-123456", state: "server-state" };
const config = { isolatedHostUrl: "https://idp.example.test", redirectUri: "https://app.example.test/auth/callback" };
const challenge = { challengeId: "challenge", maskedRecipient: "u***@example.test", expiresAt: new Date(Date.now() + 600_000).toISOString(), resendAfterSeconds: 30 };
const callbackUrl = `${config.redirectUri}?state=server-state&swig_pubkey=config&wallet_address=wallet&role_id=7#id_token=app-token`;

function environment(t, handler) {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  const calls = [];
  const frames = [];
  const browser = new EventTarget();
  browser.location = { origin: "https://app.example.test" };
  const popup = { closed: false, close() { this.closed = true; } };
  browser.open = () => popup;
  const emit = (frame, data, overrides = {}) => {
    const event = new Event("message");
    Object.assign(event, { origin: "https://idp.example.test", source: frame.contentWindow, data, ...overrides });
    browser.dispatchEvent(event);
  };
  globalThis.window = browser;
  globalThis.document = {
    createElement() {
      const frame = {
        removed: false,
        remove() { this.removed = true; },
        contentWindow: {
          postMessage(message, origin) {
            assert.equal(origin, "https://idp.example.test");
            calls.push(message.command);
            const respond = (result, extras = {}) => queueMicrotask(() => emit(frame, { ...message, kind: "response", ok: true, result, ...extras }));
            handler(message.command, respond, (data, overrides) => emit(frame, { ...message, kind: "response", ok: true, ...data }, overrides));
          },
        },
      };
      return frame;
    },
    body: { append(frame) { frames.push(frame); queueMicrotask(() => emit(frame, { type: "swig:email-otp:v1", kind: "ready", channel: new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel") })); } },
    querySelectorAll() { return frames.filter((frame) => !frame.removed); },
  };
  t.after(() => { globalThis.window = savedWindow; globalThis.document = savedDocument; });
  return { calls, frames, popup, browser };
}

test("email operations preserve app bindings, return only completion, and release the frame", async (t) => {
  const env = environment(t, (command, respond) => respond(command.method === "start" ? challenge : command.method === "resend" ? { resendAfterSeconds: 30 } : { status: "complete", callbackUrl }));
  const client = new EmailOtpClient(config);
  assert.deepEqual(await client.start(input), challenge);
  assert.deepEqual(env.calls[0].input, { ...input, redirectUri: config.redirectUri, network: 1 });
  assert.equal(new URL(env.frames[0].src).pathname, "/email-otp-bridge.html");
  assert.equal(env.frames[0].src.includes(input.email), false);
  assert.deepEqual(await client.resend({ challengeId: challenge.challengeId }), { resendAfterSeconds: 30 });
  assert.deepEqual(await client.verify({ challengeId: challenge.challengeId, code: "123456" }), { status: "complete", callbackUrl });
  assert.equal(env.frames[0].removed, true);
});

test("ignores wrong source, origin, channel, and request ID before accepting a correlated response", async (t) => {
  environment(t, (_command, respond, emit) => {
    for (const overrides of [{ origin: "https://evil.example.test" }, { source: {} }]) emit({ result: { wrong: true } }, overrides);
    emit({ channel: "wrong", result: { wrong: true } });
    emit({ requestId: "wrong", result: { wrong: true } });
    respond(challenge);
  });
  const client = new EmailOtpClient(config);
  t.after(() => client.cancel());
  assert.deepEqual(await client.start(input), challenge);
});

test("bad codes are retryable; other challenges and malformed input cannot reach the host", async (t) => {
  let attempts = 0;
  const env = environment(t, (command, respond) => {
    if (command.method === "start") respond(challenge);
    else if (attempts++ === 0) respond(null, { ok: false, code: "invalid_code", message: "Invalid or expired code" });
    else respond({ status: "complete", callbackUrl });
  });
  const client = new EmailOtpClient(config);
  await client.start(input);
  await assert.rejects(client.verify({ challengeId: "other", code: "123456" }), { code: "invalid_challenge" });
  await assert.rejects(client.verify({ challengeId: "challenge", code: "bad" }), { code: "invalid_code" });
  assert.equal(env.calls.length, 1);
  await assert.rejects(client.verify({ challengeId: "challenge", code: "123456" }), { code: "invalid_code" });
  assert.equal(env.frames[0].removed, false);
  await client.verify({ challengeId: "challenge", code: "123456" });
});

test("rejects malformed completion, another origin, callback path, state, or missing app token", async (t) => {
  let completion;
  const env = environment(t, (command, respond) => respond(command.method === "start" ? challenge : completion));
  for (const value of [{}, { status: "complete", callbackUrl: "invalid url" }, { status: "complete", callbackUrl: "https://evil.example.test/#id_token=token" }, { status: "complete", callbackUrl: callbackUrl.replace("/auth/callback", "/wrong") }, { status: "complete", callbackUrl: callbackUrl.replace("server-state", "wrong-state") }, { status: "complete", callbackUrl: callbackUrl.split("#")[0] }]) {
    completion = value;
    const client = new EmailOtpClient(config);
    await client.start(input);
    await assert.rejects(client.verify({ challengeId: "challenge", code: "123456" }), EmailOtpError);
    assert.equal(env.frames.at(-1).removed, true);
  }
});

test("aborting a request releases the frame, rejects concurrent calls, and preserves abort reason", async (t) => {
  const env = environment(t, () => {});
  const client = new EmailOtpClient(config);
  const abort = new AbortController();
  const pending = client.start(input, { signal: abort.signal });
  await Promise.resolve();
  await assert.rejects(client.start(input), { code: "busy" });
  const reason = new Error("user cancelled");
  abort.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(env.frames[0].removed, true);
  client.cancel();
});

test("new wallet access opens a trusted popup synchronously and completes only after approval", async (t) => {
  const env = environment(t, (command, respond) => respond(command.method === "start" ? challenge : command.method === "verify" ? { status: "approval_required", approvalId: "approval" } : { status: "complete", callbackUrl }));
  const client = new EmailOtpClient(config);
  await client.start(input);
  assert.deepEqual(await client.verify({ challengeId: "challenge", code: "123456" }), { status: "approval_required" });
  let opened = false;
  env.browser.open = (url) => { opened = true; assert.equal(new URL(url).pathname, "/email-otp/approval"); return env.popup; };
  const result = client.approve({ challengeId: "challenge" });
  assert.equal(opened, true);
  assert.deepEqual(await result, { status: "complete", callbackUrl });
  assert.equal(env.popup.closed, true);
});

test("a blocked approval popup can be retried without verifying the code again", async (t) => {
  const env = environment(t, (command, respond) => respond(command.method === "start" ? challenge : command.method === "verify" ? { status: "approval_required", approvalId: "approval" } : { status: "complete", callbackUrl }));
  const client = new EmailOtpClient(config);
  await client.start(input);
  await client.verify({ challengeId: "challenge", code: "123456" });
  env.browser.open = () => null;
  await assert.rejects(client.approve({ challengeId: "challenge" }), { code: "popup_blocked" });
  env.browser.open = () => env.popup;
  await client.approve({ challengeId: "challenge" });
  assert.equal(env.calls.filter((call) => call.method === "verify").length, 1);
});
