import { DEFAULT_ISOLATED_HOST_URL, DEFAULT_NETWORK } from "./config.js";
import { createRequestId, Network, type NetworkValue } from "./utils.js";

/**
 * Embedded isolated-host client.
 *
 * Mounts the IH /embedded page as a persistent iframe and exposes a typed
 * postMessage RPC. The iframe owns the login credential in its partitioned
 * storage; consent UI renders inside it; only public data crosses back.
 *
 * Login: call login(provider) synchronously from a user click — the SDK
 * opens the OAuth popup from the host context (where the activation lives),
 * asks the iframe for the start URL, and navigates the popup. The popup's
 * completion page delivers the credential straight to the iframe (IH→IH);
 * this window never sees it.
 */

const EMBEDDED_REQUEST_TYPE = "swig:embedded:request";
const EMBEDDED_RESPONSE_TYPE = "swig:embedded:response";
const EMBEDDED_EVENT_TYPE = "swig:embedded:event";

const DEFAULT_RPC_TIMEOUT_MS = 20_000;
/** Consent-gated calls wait on a human; effectively no timeout. */
const CONSENT_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const POPUP_FEATURES = "popup=yes,width=480,height=660";

export type EmbeddedSession = {
  swigPubkey: string;
  walletAddress: string;
  roleId: number;
  authFlow: string;
};

export type EmbeddedUiState = "idle" | "busy" | "consent";

export type RoleOperationResult = {
  status: string;
  signature?: string;
};

export type SwigEmbeddedConfig = {
  clientId: string;
  /**
   * Registered callback URL for this app; its origin must match the page
   * embedding the iframe (the IH enforces this). Defaults to
   * `${location.origin}/auth/callback`.
   */
  redirectUri?: string;
  isolatedHostUrl?: string;
  network?: NetworkValue;
  /** Where to mount the iframe. Defaults to document.body. */
  container?: HTMLElement;
};

export class SwigEmbeddedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SwigEmbeddedError";
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class SwigEmbedded {
  readonly iframe: HTMLIFrameElement;

  private readonly ihOrigin: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionListeners = new Set<(session: EmbeddedSession | null) => void>();
  private readonly uiListeners = new Set<(state: EmbeddedUiState) => void>();
  private currentSession: EmbeddedSession | null = null;
  private loginWaiter:
    | { resolve: (session: EmbeddedSession) => void; reject: (error: Error) => void }
    | null = null;
  private readonly onMessage: (event: MessageEvent) => void;

  private constructor(
    private readonly config: SwigEmbeddedConfig,
    iframe: HTMLIFrameElement,
    ihOrigin: string,
  ) {
    this.iframe = iframe;
    this.ihOrigin = ihOrigin;
    this.onMessage = (event) => this.handleMessage(event);
    window.addEventListener("message", this.onMessage);
  }

  /** Mounts the iframe and resolves once the IH reports ready. */
  static connect(config: SwigEmbeddedConfig): Promise<SwigEmbedded> {
    const isolatedHostUrl = (config.isolatedHostUrl ?? DEFAULT_ISOLATED_HOST_URL).replace(
      /\/+$/,
      "",
    );
    const ihOrigin = new URL(isolatedHostUrl).origin;
    const redirectUri = config.redirectUri ?? defaultRedirectUri();
    const url = new URL(`${isolatedHostUrl}/embedded`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("network", String(config.network ?? DEFAULT_NETWORK));

    const iframe = document.createElement("iframe");
    iframe.src = url.toString();
    iframe.title = "Swig";
    iframe.style.border = "0";
    iframe.style.width = "100%";
    iframe.style.height = "100%";

    const client = new SwigEmbedded(config, iframe, ihOrigin);

    return new Promise<SwigEmbedded>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.destroy();
        reject(new SwigEmbeddedError("timeout", "Timed out waiting for the isolated host"));
      }, DEFAULT_RPC_TIMEOUT_MS);

      client.readyWaiter = () => {
        clearTimeout(timer);
        resolve(client);
      };

      (config.container ?? document.body).appendChild(iframe);
    });
  }

  private readyWaiter: (() => void) | null = null;

  get session(): EmbeddedSession | null {
    return this.currentSession;
  }

  onSessionChanged(listener: (session: EmbeddedSession | null) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  onUiState(listener: (state: EmbeddedUiState) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  /**
   * Starts a provider login. MUST be called synchronously from a user
   * gesture (click handler) so the popup is allowed.
   */
  login(provider: string): Promise<EmbeddedSession> {
    if (this.loginWaiter) {
      return Promise.reject(new SwigEmbeddedError("busy", "A login is already in progress"));
    }

    const popup = window.open("about:blank", "swig-embedded-auth", POPUP_FEATURES);
    if (!popup) {
      return Promise.reject(
        new SwigEmbeddedError("popup_blocked", "The browser blocked the sign-in popup"),
      );
    }

    return new Promise<EmbeddedSession>((resolve, reject) => {
      let closePoll: ReturnType<typeof setInterval> | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const settle = (fn: () => void) => {
        this.loginWaiter = null;
        if (closePoll) clearInterval(closePoll);
        if (timeout) clearTimeout(timeout);
        fn();
      };

      this.loginWaiter = {
        resolve: (session) => settle(() => resolve(session)),
        reject: (error) => settle(() => reject(error)),
      };

      timeout = setTimeout(() => {
        popup.close();
        this.loginWaiter?.reject(new SwigEmbeddedError("timeout", "Sign-in timed out"));
      }, LOGIN_TIMEOUT_MS);

      closePoll = setInterval(() => {
        if (popup.closed && this.loginWaiter) {
          this.loginWaiter.reject(
            new SwigEmbeddedError("popup_closed", "The sign-in window was closed"),
          );
        }
      }, 500);

      this.request<{ startUrl: string }>("login_start", { provider })
        .then(({ startUrl }) => {
          // Compare parsed origins, not a string prefix: a prefix check would
          // accept e.g. "https://ih.example.com.attacker.com/…".
          let startUrlOrigin: string | null = null;
          try {
            startUrlOrigin = new URL(startUrl).origin;
          } catch {
            startUrlOrigin = null;
          }
          if (startUrlOrigin !== this.ihOrigin) {
            popup.close();
            this.loginWaiter?.reject(
              new SwigEmbeddedError("internal_error", "Unexpected start URL origin"),
            );
            return;
          }
          popup.location.href = startUrl;
          popup.focus();
        })
        .catch((error: unknown) => {
          popup.close();
          this.loginWaiter?.reject(
            error instanceof Error ? error : new SwigEmbeddedError("internal_error", "Login failed"),
          );
        });
    });
  }

  async getSession(): Promise<EmbeddedSession | null> {
    return this.request<EmbeddedSession | null>("get_session", {});
  }

  /** Adds a policy role. The user approves inside the isolated host UI. */
  async addRole(policyId: string): Promise<RoleOperationResult> {
    return this.request<RoleOperationResult>("add_role", { policyId }, CONSENT_TIMEOUT_MS);
  }

  /** Removes a role. The user approves inside the isolated host UI. */
  async removeRole(roleId: number, roleName?: string): Promise<RoleOperationResult> {
    return this.request<RoleOperationResult>(
      "remove_role",
      { roleId, ...(roleName ? { roleName } : {}) },
      CONSENT_TIMEOUT_MS,
    );
  }

  async logout(): Promise<void> {
    await this.request("logout", {});
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SwigEmbeddedError("destroyed", "Embedded client destroyed"));
    }
    this.pending.clear();
    this.iframe.remove();
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    const target = this.iframe.contentWindow;
    if (!target) {
      return Promise.reject(new SwigEmbeddedError("not_ready", "Isolated host not mounted"));
    }
    const id = createRequestId();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SwigEmbeddedError("timeout", `Isolated host did not answer ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      target.postMessage({ type: EMBEDDED_REQUEST_TYPE, id, method, params }, this.ihOrigin);
    });
  }

  private handleMessage(event: MessageEvent) {
    if (event.origin !== this.ihOrigin || event.source !== this.iframe.contentWindow) {
      return;
    }
    const data = event.data as {
      type?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: { code?: string; message?: string };
      event?: unknown;
      session?: EmbeddedSession | null;
      protocolVersion?: number;
      state?: EmbeddedUiState;
      message?: string;
    };

    if (data?.type === EMBEDDED_RESPONSE_TYPE && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.ok) {
        pending.resolve(data.result);
      } else {
        pending.reject(
          new SwigEmbeddedError(
            data.error?.code ?? "internal_error",
            data.error?.message ?? "Isolated host request failed",
          ),
        );
      }
      return;
    }

    if (data?.type !== EMBEDDED_EVENT_TYPE) {
      return;
    }

    switch (data.event) {
      case "ready": {
        this.currentSession = data.session ?? null;
        this.readyWaiter?.();
        this.readyWaiter = null;
        break;
      }
      case "session_changed": {
        this.currentSession = data.session ?? null;
        for (const listener of this.sessionListeners) {
          listener(this.currentSession);
        }
        break;
      }
      case "login_result": {
        if (data.ok && data.session) {
          this.loginWaiter?.resolve(data.session);
        } else {
          this.loginWaiter?.reject(
            new SwigEmbeddedError("login_failed", data.message ?? "Sign-in failed"),
          );
        }
        break;
      }
      case "ui": {
        if (data.state) {
          for (const listener of this.uiListeners) {
            listener(data.state);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

export const connectSwigEmbedded = (config: SwigEmbeddedConfig): Promise<SwigEmbedded> =>
  SwigEmbedded.connect(config);

const defaultRedirectUri = (): string => {
  if (typeof window === "undefined") {
    throw new SwigEmbeddedError(
      "invalid_request",
      "redirectUri is required outside a browser (window is unavailable)",
    );
  }
  return `${window.location.origin}/auth/callback`;
};

export { Network };
export type { NetworkValue };
