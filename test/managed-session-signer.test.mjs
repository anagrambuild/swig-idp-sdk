import assert from "node:assert/strict";
import test from "node:test";

import { createSwigWebClient, Network, parseOAuthCallbackUrl } from "../dist/web.js";

const APP_ORIGIN = "https://app.example";
const ISOLATED_HOST_ORIGIN = "https://idp.example";
const SESSION_PUBLIC_KEY = "11111111111111111111111111111111";

function createStorage(session) {
  let value = JSON.stringify(session);
  return {
    async getItem() {
      return value;
    },
    async setItem(_key, nextValue) {
      value = nextValue;
    },
    async removeItem() {
      value = null;
    },
  };
}

function createPopup() {
  const posted = [];
  const navigations = [];
  return {
    closed: false,
    location: {
      replace(url) {
        navigations.push(url);
      },
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
    close() {
      this.closed = true;
    },
    navigations,
    posted,
  };
}

function createBrowserHarness({ popup = createPopup() } = {}) {
  const listeners = new Set();
  const opened = [];
  const browserWindow = {
    open(url, name, features) {
      opened.push({ url, name, features });
      return popup;
    },
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
    },
  };

  return {
    browserWindow,
    opened,
    popup,
    dispatch(data, { origin = ISOLATED_HOST_ORIGIN, source = popup } = {}) {
      for (const listener of listeners) {
        listener({ data, origin, source });
      }
    },
  };
}

function createSession(overrides = {}) {
  return {
    configAddress: "swig-config",
    walletAddress: "swig-wallet",
    roleId: 1,
    authFlow: "session",
    updatedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    authorityPublicKey: SESSION_PUBLIC_KEY,
    ...overrides,
  };
}

async function waitFor(condition) {
  for (let attempts = 0; attempts < 20; attempts += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

test("managed-session signer uses an isolated-host popup and accepts only its correlated messages", async () => {
  const browser = createBrowserHarness();
  const originalWindow = globalThis.window;
  globalThis.window = browser.browserWindow;

  try {
    const client = createSwigWebClient({
      isolatedHostUrl: ISOLATED_HOST_ORIGIN,
      redirectUri: `${APP_ORIGIN}/callback`,
      storage: createStorage(createSession()),
      network: Network.Devnet,
    });
    const signer = client.createSigner({
      clientId: "client-1",
      timeoutMs: 1_000,
    });
    const signing = signer.signPreparedTransaction({
      transaction: "unsigned-base64",
      transactionEncoding: "base64",
      network: "solana_devnet",
    });

    await waitFor(() => browser.popup.navigations.length === 1);
    assert.equal(browser.opened[0].url, "");
    const signUrl = new URL(browser.popup.navigations[0]);
    const requestId = signUrl.searchParams.get("request_id");
    assert.equal(signUrl.pathname, "/transaction/sign");
    assert.equal(signUrl.searchParams.get("swig_pubkey"), "swig-config");

    browser.dispatch(
      {
        type: "swig:idp-transaction-sign-ready",
        requestId,
        sessionPublicKey: SESSION_PUBLIC_KEY,
      },
      { source: createPopup() },
    );
    assert.equal(browser.popup.posted.length, 0);

    browser.dispatch({
      type: "swig:idp-transaction-sign-ready",
      requestId,
      sessionPublicKey: SESSION_PUBLIC_KEY,
    });
    assert.deepEqual(browser.popup.posted, [
      {
        targetOrigin: ISOLATED_HOST_ORIGIN,
        message: {
          type: "swig:idp-transaction-sign",
          requestId,
          prepared: {
            transaction: "unsigned-base64",
            transactionEncoding: "base64",
            network: "solana_devnet",
          },
        },
      },
    ]);

    browser.dispatch({
      type: "swig:idp-transaction-sign-result",
      requestId,
      sessionPublicKey: SESSION_PUBLIC_KEY,
      status: "signed",
      signed: {
        transaction: "signed-base64",
        transactionEncoding: "base64",
        network: "solana_devnet",
      },
    });

    assert.deepEqual(await signing, {
      transaction: "signed-base64",
      transactionEncoding: "base64",
      network: "solana_devnet",
    });
    assert.equal(browser.popup.closed, true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("managed-session signer refuses a session without an isolated-host public key", async () => {
  const browser = createBrowserHarness();
  const originalWindow = globalThis.window;
  globalThis.window = browser.browserWindow;

  try {
    const client = createSwigWebClient({
      isolatedHostUrl: ISOLATED_HOST_ORIGIN,
      redirectUri: `${APP_ORIGIN}/callback`,
      storage: createStorage(createSession({ authorityPublicKey: undefined })),
    });

    await assert.rejects(
      client.createSigner({ clientId: "client-1" }).signPreparedTransaction({
        transaction: "unsigned-base64",
        transactionEncoding: "base64",
      }),
      /No active isolated-host managed session/,
    );
    assert.equal(browser.popup.closed, true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("managed-session signer refuses caller-supplied metadata that does not match storage", async () => {
  const browser = createBrowserHarness();
  const originalWindow = globalThis.window;
  globalThis.window = browser.browserWindow;

  try {
    const client = createSwigWebClient({
      isolatedHostUrl: ISOLATED_HOST_ORIGIN,
      redirectUri: `${APP_ORIGIN}/callback`,
      storage: createStorage(createSession()),
    });

    await assert.rejects(
      client
        .createSigner({
          clientId: "client-1",
          session: createSession({ authorityPublicKey: "attacker-controlled-key" }),
        })
        .signPreparedTransaction({
          transaction: "unsigned-base64",
          transactionEncoding: "base64",
        }),
      /No active isolated-host managed session/,
    );
    assert.equal(browser.popup.closed, true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test("session callbacks require the isolated-host key and its expiration", () => {
  const expiresAt = Date.now() + 60_000;
  const callback = new URL(`${APP_ORIGIN}/callback`);
  callback.hash = new URLSearchParams({
    swig_pubkey: "swig-config",
    wallet_address: "swig-wallet",
    role_id: "1",
    auth_flow: "session",
    authority_public_key: SESSION_PUBLIC_KEY,
    session_expires_at: String(expiresAt),
  }).toString();

  const beforeParse = Date.now();
  const session = parseOAuthCallbackUrl(callback);
  assert.equal(session.configAddress, "swig-config");
  assert.equal(session.walletAddress, "swig-wallet");
  assert.equal(session.roleId, 1);
  assert.equal(session.authFlow, "session");
  assert.equal(session.authorityPublicKey, SESSION_PUBLIC_KEY);
  assert.equal(session.expiresAt, expiresAt);
  assert.ok(session.updatedAt >= beforeParse && session.updatedAt <= Date.now());

  callback.hash = new URLSearchParams({
    swig_pubkey: "swig-config",
    wallet_address: "swig-wallet",
    role_id: "1",
    auth_flow: "session",
    session_expires_at: String(expiresAt),
  }).toString();
  assert.throws(() => parseOAuthCallbackUrl(callback), /authority_public_key/);
});
