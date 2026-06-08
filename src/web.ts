import {
  DEFAULT_BACKEND_API_URL,
  DEFAULT_ISOLATED_HOST_URL,
  DEFAULT_NETWORK,
} from "./config.js";
import {
  buildIsolatedHostStartUrl,
  parseAgentRevokeCallbackUrl,
  parseOAuthCallbackUrl,
  type AgentRevokeCallbackResult,
} from "./states/oauth-callback.js";
import {
  SwigApiClient,
  type ListAgentsResponse,
  type ListProvidersResponse,
  type SwigBackendEndpoints,
  type UpdateAgentReputationResponse,
} from "./transport/api.js";
import { Network, type NetworkValue } from "./utils.js";
import type { PersistedSwigSession } from "./swig-session/session-store.js";

export type WebSessionStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type WebSessionDataResponse = {
  configAddress: string;
  walletAddress: string;
  roleId: number;
};

export type SwigWebSdkConfig = {
  /** Optional override for the backend API base URL */
  baseUrl?: string;
  /** Optional override for the isolated host URL */
  isolatedHostUrl?: string;
  /** Web callback URL, e.g. "https://app.example.com/auth/callback" */
  redirectUri?: string;
  endpoints?: Partial<SwigBackendEndpoints>;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  /** Defaults to window.localStorage in the browser. */
  storage?: WebSessionStorageAdapter;
  storageKey?: string;
  /** Defaults to one hour and only applies to non-secret app session metadata. */
  sessionTtlMs?: number;
  network?: NetworkValue;
};

export type StartWebOAuthInput = {
  /** OAuth provider key, e.g. "google" or "demo-oidc" */
  provider: string;
  /** Developer's client ID */
  clientId: string;
  /** Flow type. The callback parser currently persists role-flow session data. */
  flow?: "role" | "session";
  /** Policy ID for role flow */
  policyId?: string;
  /** Optional Ed25519 public key to add as the role authority. */
  authorityPublicKey?: string;
  /** Optional role intent used by One Wallet agent connect. */
  roleIntent?: "agent";
  /** Optional agent display name for agent role additions. */
  agentName?: string;
  /** Optional per-request redirect URI override */
  redirectUri?: string;
  /** Optional state to send to the backend start endpoint */
  state?: string;
  /** Optional per-request network override */
  network?: NetworkValue;
};

export type RedirectToOAuthOptions = {
  mode?: "assign" | "replace";
  location?: Pick<Location, "assign" | "replace">;
};

export type ProofSessionOperationStatus = "ready" | "expired" | "signed_out" | "error";

export type ProofSessionOperationResult = {
  requestId: string;
  status: ProofSessionOperationStatus;
  message?: string;
};

export type ProofSessionOperationInput = {
  clientId: string;
  redirectUri?: string;
  swigPubkey?: string;
  network?: NetworkValue;
  timeoutMs?: number;
};

export type EnsureProofSessionInput = ProofSessionOperationInput & {
  session?: PersistedSwigSession | null;
};

export type EnsureProofSessionResult =
  | {
      status: "ready";
      session: PersistedSwigSession;
      requestId: string;
    }
  | {
      status: "reauth_required";
      session: PersistedSwigSession | null;
      reason: "missing_session" | "expired" | "signed_out" | "refresh_failed";
      refreshUrl?: string;
      requestId?: string;
      message?: string;
    };

export class SwigProofSessionReauthRequiredError extends Error {
  constructor(readonly result: Extract<EnsureProofSessionResult, { status: "reauth_required" }>) {
    super(result.message ?? "Swig IdP proof session requires top-level re-authentication");
    this.name = "SwigProofSessionReauthRequiredError";
  }
}

export type IsolatedHostPreparedTransaction = {
  transaction: string;
  transactionEncoding?: string;
  network?: unknown;
};

export type IsolatedHostSignedTransaction = {
  transaction: string;
  transactionEncoding?: string;
  network?: unknown;
};

export type IsolatedHostSignerInput = ProofSessionOperationInput & {
  session?: PersistedSwigSession | null;
};

export type IsolatedHostSigner = {
  signPreparedTransaction(
    prepared: IsolatedHostPreparedTransaction,
  ): Promise<IsolatedHostSignedTransaction>;
};

export type RevokeAgentInput = {
  /** Developer's client ID */
  clientId: string;
  /** Swig config public key containing the agent role. */
  swigPubkey: string;
  /** Optional Swig wallet address for callback context. */
  walletAddress?: string;
  /** Agent role id to revoke. */
  roleId: number;
  /** Optional agent authority public key for display and callback correlation. */
  authorityPublicKey?: string;
  /** Optional agent display name. */
  agentName?: string;
  /** Optional per-request redirect URI override */
  redirectUri?: string;
  /** Optional per-request network override */
  network?: NetworkValue;
};

const DEFAULT_STORAGE_KEY = "swig.idp.session";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PROOF_SESSION_TIMEOUT_MS = 10_000;
const PROOF_SESSION_MESSAGE_TYPE = "swig:idp-session-refresh";
const TRANSACTION_SIGN_READY_MESSAGE_TYPE = "swig:idp-transaction-sign-ready";
const TRANSACTION_SIGN_REQUEST_MESSAGE_TYPE = "swig:idp-transaction-sign";
const TRANSACTION_SIGN_RESULT_MESSAGE_TYPE = "swig:idp-transaction-sign-result";

class BrowserLocalStorageAdapter implements WebSessionStorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return getBrowserLocalStorage().getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    getBrowserLocalStorage().setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    getBrowserLocalStorage().removeItem(key);
  }
}

class WebSessionStore {
  constructor(
    private readonly storage: WebSessionStorageAdapter,
    private readonly storageKey: string,
    private readonly sessionTtlMs: number,
  ) {}

  async load(): Promise<PersistedSwigSession | null> {
    const raw = await this.storage.getItem(this.storageKey);

    if (!raw) {
      return null;
    }

    try {
      const session = JSON.parse(raw) as PersistedSwigSession;
      if (!session.configAddress || !session.walletAddress || session.roleId == null) {
        await this.clear();
        return null;
      }
      if (
        !Number.isFinite(session.updatedAt) ||
        Date.now() - session.updatedAt >= this.sessionTtlMs
      ) {
        await this.clear();
        return null;
      }
      return session;
    } catch {
      await this.clear();
      return null;
    }
  }

  async save(session: PersistedSwigSession): Promise<void> {
    await this.storage.setItem(this.storageKey, JSON.stringify(session));
  }

  async touch(): Promise<PersistedSwigSession | null> {
    const session = await this.load();
    if (!session) {
      return null;
    }
    const updatedSession = { ...session, updatedAt: Date.now() };
    await this.save(updatedSession);
    return updatedSession;
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.storageKey);
  }
}

export class SwigWebSdk {
  private readonly api: SwigApiClient;
  private readonly isolatedHostUrl: string;
  private readonly redirectUri: string | undefined;
  private readonly network: NetworkValue;
  private readonly sessionStore: WebSessionStore;

  constructor(config: SwigWebSdkConfig = {}) {
    this.isolatedHostUrl = config.isolatedHostUrl ?? DEFAULT_ISOLATED_HOST_URL;
    this.redirectUri = config.redirectUri;
    this.network = config.network ?? DEFAULT_NETWORK;
    this.sessionStore = new WebSessionStore(
      config.storage ?? new BrowserLocalStorageAdapter(),
      config.storageKey ?? DEFAULT_STORAGE_KEY,
      config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    );

    this.api = new SwigApiClient({
      baseUrl: config.baseUrl ?? DEFAULT_BACKEND_API_URL,
      ...(config.endpoints ? { endpoints: config.endpoints } : {}),
      ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async listProviders(input: { clientId: string }): Promise<ListProvidersResponse> {
    return this.api.listProviders({ client_id: input.clientId });
  }

  async getOAuthStartUrl(input: StartWebOAuthInput): Promise<string> {
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    const flow = input.flow ?? "role";
    const { redirectUrl, startToken, state: nonce } = await this.api.startAuth({
      provider: input.provider,
      client_id: input.clientId,
      redirect_uri: redirectUri,
      state: input.state ?? "",
      network: input.network ?? this.network,
      flow,
      ...(input.policyId ? { policy_id: input.policyId } : {}),
      ...(input.authorityPublicKey ? { authority_public_key: input.authorityPublicKey } : {}),
      ...(input.roleIntent ? { role_intent: input.roleIntent } : {}),
      ...(input.agentName ? { agent_name: input.agentName } : {}),
    });

    return buildIsolatedHostStartUrl({
      isolatedHostUrl: this.isolatedHostUrl,
      redirectUri,
      redirectUrl,
      nonce,
      flow,
      clientId: input.clientId,
      ...(startToken ? { startToken } : {}),
      ...(input.policyId ? { policyId: input.policyId } : {}),
      ...(input.authorityPublicKey ? { authorityPublicKey: input.authorityPublicKey } : {}),
      ...(input.roleIntent ? { roleIntent: input.roleIntent } : {}),
      ...(input.agentName ? { agentName: input.agentName } : {}),
    });
  }

  async getAddAuthorityStartUrl(
    input: Omit<StartWebOAuthInput, "flow"> & { authorityPublicKey: string },
  ): Promise<string> {
    return this.getOAuthStartUrl({
      ...input,
      flow: "role",
    });
  }

  async redirectToAddAuthority(
    input: Omit<StartWebOAuthInput, "flow"> & { authorityPublicKey: string },
    options: RedirectToOAuthOptions = {},
  ): Promise<void> {
    const startUrl = await this.getAddAuthorityStartUrl(input);
    const location = options.location ?? getBrowserLocation();

    if (options.mode === "replace") {
      location.replace(startUrl);
      return;
    }

    location.assign(startUrl);
  }

  async getRevokeAgentStartUrl(input: RevokeAgentInput): Promise<string> {
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    const normalizedBaseUrl = this.isolatedHostUrl.endsWith("/")
      ? this.isolatedHostUrl.slice(0, -1)
      : this.isolatedHostUrl;
    const url = new URL(`${normalizedBaseUrl}/agent/revoke`);

    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("swig_pubkey", input.swigPubkey);
    url.searchParams.set("role_id", String(input.roleId));
    url.searchParams.set("network", String(input.network ?? this.network));

    if (input.walletAddress) {
      url.searchParams.set("wallet_address", input.walletAddress);
    }
    if (input.authorityPublicKey) {
      url.searchParams.set("authority_public_key", input.authorityPublicKey);
    }
    if (input.agentName) {
      url.searchParams.set("agent_name", input.agentName);
    }

    return url.toString();
  }

  async redirectToRevokeAgent(
    input: RevokeAgentInput,
    options: RedirectToOAuthOptions = {},
  ): Promise<void> {
    const startUrl = await this.getRevokeAgentStartUrl(input);
    const location = options.location ?? getBrowserLocation();

    if (options.mode === "replace") {
      location.replace(startUrl);
      return;
    }

    location.assign(startUrl);
  }

  async redirectToOAuth(
    input: StartWebOAuthInput,
    options: RedirectToOAuthOptions = {},
  ): Promise<void> {
    const startUrl = await this.getOAuthStartUrl(input);
    const location = options.location ?? getBrowserLocation();

    if (options.mode === "replace") {
      location.replace(startUrl);
      return;
    }

    location.assign(startUrl);
  }

  async completeOAuthFromUrl(url?: string | URL): Promise<PersistedSwigSession> {
    const session = parseOAuthCallbackUrl(url ?? getBrowserLocationHref());
    await this.sessionStore.save(session);
    return session;
  }

  completeAgentRevokeFromUrl(url?: string | URL): AgentRevokeCallbackResult {
    return parseAgentRevokeCallbackUrl(url ?? getBrowserLocationHref());
  }

  parseOAuthCallbackUrl(url: string | URL): PersistedSwigSession {
    return parseOAuthCallbackUrl(url);
  }

  async getSession(): Promise<WebSessionDataResponse | null> {
    const persisted = await this.sessionStore.load();
    if (!persisted) return null;

    return {
      configAddress: persisted.configAddress,
      walletAddress: persisted.walletAddress,
      roleId: persisted.roleId,
    };
  }

  async getPersistedSession(): Promise<PersistedSwigSession | null> {
    return this.sessionStore.load();
  }

  async touchSession(): Promise<PersistedSwigSession | null> {
    return this.sessionStore.touch();
  }

  getProofSessionRefreshUrl(
    input: ProofSessionOperationInput & {
      mode?: "refresh" | "logout";
      requestId?: string;
    },
  ): string {
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    const normalizedBaseUrl = this.isolatedHostUrl.endsWith("/")
      ? this.isolatedHostUrl.slice(0, -1)
      : this.isolatedHostUrl;
    const url = new URL(`${normalizedBaseUrl}/session/refresh`);

    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("request_id", input.requestId ?? createRequestId());
    url.searchParams.set("mode", input.mode ?? "refresh");
    url.searchParams.set("network", String(input.network ?? this.network));
    if (input.swigPubkey) {
      url.searchParams.set("swig_pubkey", input.swigPubkey);
    }

    return url.toString();
  }

  async refreshProofSession(
    input: ProofSessionOperationInput,
  ): Promise<ProofSessionOperationResult> {
    return this.runProofSessionOperation({ ...input, mode: "refresh" });
  }

  async clearProofSession(input: ProofSessionOperationInput): Promise<ProofSessionOperationResult> {
    return this.runProofSessionOperation({ ...input, mode: "logout" });
  }

  async ensureProofSession(input: EnsureProofSessionInput): Promise<EnsureProofSessionResult> {
    const session = input.session ?? (await this.sessionStore.load());
    if (!session) {
      return {
        status: "reauth_required",
        session: null,
        reason: "missing_session",
        refreshUrl: this.getProofSessionRefreshUrl(input),
        message: "No persisted Swig IdP session",
      };
    }

    const refreshUrl = this.getProofSessionRefreshUrl({
      ...input,
      swigPubkey: input.swigPubkey ?? session.configAddress,
    });

    let result: ProofSessionOperationResult;
    try {
      result = await this.refreshProofSession({
        ...input,
        swigPubkey: input.swigPubkey ?? session.configAddress,
      });
    } catch (error) {
      return {
        status: "reauth_required",
        session,
        reason: "refresh_failed",
        refreshUrl,
        message: error instanceof Error ? error.message : "Unable to refresh Swig IdP session",
      };
    }

    if (result.status === "ready") {
      const refreshedSession = await this.sessionStore.touch();
      if (refreshedSession) {
        return {
          status: "ready",
          session: refreshedSession,
          requestId: result.requestId,
        };
      }

      return {
        status: "reauth_required",
        session,
        reason: "expired",
        refreshUrl,
        requestId: result.requestId,
        message: "Persisted Swig IdP session expired",
      };
    }

    if (result.status === "error") {
      return {
        status: "reauth_required",
        session,
        reason: "refresh_failed",
        refreshUrl,
        requestId: result.requestId,
        message: result.message ?? "Unable to refresh Swig IdP session",
      };
    }

    return {
      status: "reauth_required",
      session,
      reason: result.status,
      refreshUrl,
      requestId: result.requestId,
      message: result.message ?? "Swig IdP proof session expired",
    };
  }

  async requireProofSession(input: EnsureProofSessionInput): Promise<PersistedSwigSession> {
    const result = await this.ensureProofSession(input);
    if (result.status === "ready") {
      return result.session;
    }
    throw new SwigProofSessionReauthRequiredError(result);
  }

  createSigner(input: IsolatedHostSignerInput): IsolatedHostSigner {
    return {
      signPreparedTransaction: (prepared) => {
        return this.signPreparedTransactionWithIsolatedHost(prepared, input);
      },
    };
  }

  getTransactionSignUrl(
    input: ProofSessionOperationInput & {
      requestId?: string;
    },
  ): string {
    const redirectUri = this.resolveRedirectUri(input.redirectUri);
    const normalizedBaseUrl = this.isolatedHostUrl.endsWith("/")
      ? this.isolatedHostUrl.slice(0, -1)
      : this.isolatedHostUrl;
    const url = new URL(`${normalizedBaseUrl}/transaction/sign`);

    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("request_id", input.requestId ?? createRequestId());
    url.searchParams.set("network", String(input.network ?? this.network));
    if (input.swigPubkey) {
      url.searchParams.set("swig_pubkey", input.swigPubkey);
    }

    return url.toString();
  }

  async listAgents(input: {
    clientId: string;
    swigPubkey: string;
    network?: NetworkValue;
  }): Promise<ListAgentsResponse> {
    return this.api.listAgents({
      client_id: input.clientId,
      swig_pubkey: input.swigPubkey,
      network: input.network ?? this.network,
    });
  }

  async updateAgentReputation(input: {
    clientId: string;
    swigPubkey: string;
    roleId: number;
    reputationScore: number;
    network?: NetworkValue;
  }): Promise<UpdateAgentReputationResponse> {
    return this.api.updateAgentReputation({
      client_id: input.clientId,
      swig_pubkey: input.swigPubkey,
      network: input.network ?? this.network,
      role_id: input.roleId,
      reputation_score: input.reputationScore,
    });
  }

  async logout(): Promise<void> {
    await this.sessionStore.clear();
  }

  private async runProofSessionOperation(
    input: ProofSessionOperationInput & { mode: "refresh" | "logout" },
  ): Promise<ProofSessionOperationResult> {
    const requestId = createRequestId();
    const url = this.getProofSessionRefreshUrl({
      ...input,
      requestId,
      mode: input.mode,
    });
    const isolatedHostOrigin = new URL(this.isolatedHostUrl).origin;
    const browserWindow = getBrowserWindow();
    const browserDocument = getBrowserDocument();

    return new Promise<ProofSessionOperationResult>((resolve, reject) => {
      const iframe = browserDocument.createElement("iframe");
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        browserWindow.removeEventListener("message", onMessage);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        iframe.remove();
      };

      const finish = (result: ProofSessionOperationResult) => {
        cleanup();
        resolve(result);
      };

      function onMessage(event: MessageEvent) {
        if (event.origin !== isolatedHostOrigin) {
          return;
        }
        if (!isProofSessionOperationMessage(event.data, requestId)) {
          return;
        }

        finish({
          requestId,
          status: event.data.status,
          ...(event.data.message ? { message: event.data.message } : {}),
        });
      }

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for isolated-host session refresh"));
      }, input.timeoutMs ?? DEFAULT_PROOF_SESSION_TIMEOUT_MS);

      iframe.src = url;
      iframe.title = "Swig IdP session refresh";
      iframe.tabIndex = -1;
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.position = "fixed";
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      iframe.style.border = "0";

      browserWindow.addEventListener("message", onMessage);
      (browserDocument.body ?? browserDocument.documentElement).appendChild(iframe);
    });
  }

  private async signPreparedTransactionWithIsolatedHost(
    prepared: IsolatedHostPreparedTransaction,
    input: IsolatedHostSignerInput,
  ): Promise<IsolatedHostSignedTransaction> {
    const session = await this.requireProofSession(input);
    const requestId = createRequestId();
    const url = this.getTransactionSignUrl({
      ...input,
      requestId,
      swigPubkey: input.swigPubkey ?? session.configAddress,
    });
    const isolatedHostOrigin = new URL(this.isolatedHostUrl).origin;
    const browserWindow = getBrowserWindow();
    const browserDocument = getBrowserDocument();

    return new Promise<IsolatedHostSignedTransaction>((resolve, reject) => {
      const iframe = browserDocument.createElement("iframe");
      let timer: ReturnType<typeof setTimeout> | null = null;
      let sentRequest = false;

      const cleanup = () => {
        browserWindow.removeEventListener("message", onMessage);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        iframe.remove();
      };

      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };

      const finish = (signed: IsolatedHostSignedTransaction) => {
        cleanup();
        resolve(signed);
      };

      function onMessage(event: MessageEvent) {
        if (event.origin !== isolatedHostOrigin) {
          return;
        }

        if (isTransactionSignReadyMessage(event.data, requestId)) {
          if (sentRequest || !iframe.contentWindow) {
            return;
          }
          sentRequest = true;
          iframe.contentWindow.postMessage(
            {
              type: TRANSACTION_SIGN_REQUEST_MESSAGE_TYPE,
              requestId,
              prepared,
            },
            isolatedHostOrigin,
          );
          return;
        }

        const result = parseTransactionSignResultMessage(event.data, requestId);
        if (!result) {
          return;
        }
        if (result.status === "signed") {
          finish(result.signed);
          return;
        }
        fail(new Error(result.message ?? "Isolated host failed to sign transaction"));
      }

      timer = setTimeout(() => {
        fail(new Error("Timed out waiting for isolated-host transaction signing"));
      }, input.timeoutMs ?? DEFAULT_PROOF_SESSION_TIMEOUT_MS);

      iframe.src = url;
      iframe.title = "Swig IdP transaction signer";
      iframe.tabIndex = -1;
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.position = "fixed";
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.opacity = "0";
      iframe.style.pointerEvents = "none";
      iframe.style.border = "0";

      browserWindow.addEventListener("message", onMessage);
      (browserDocument.body ?? browserDocument.documentElement).appendChild(iframe);
    });
  }

  private resolveRedirectUri(redirectUri?: string): string {
    const resolvedRedirectUri = redirectUri ?? this.redirectUri;

    if (!resolvedRedirectUri) {
      throw new Error("redirectUri must be set in SwigWebSdkConfig or StartWebOAuthInput");
    }

    return resolvedRedirectUri;
  }
}

export const createSwigWebClient = (config: SwigWebSdkConfig = {}): SwigWebSdk => {
  return new SwigWebSdk(config);
};

export { Network, parseOAuthCallbackUrl };
export type {
  AgentRevokeCallbackResult,
  NetworkValue,
  PersistedSwigSession,
  SwigBackendEndpoints,
  UpdateAgentReputationResponse,
};

const getBrowserLocalStorage = (): Storage => {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new Error("window.localStorage is unavailable. Pass a custom storage adapter.");
  }

  return window.localStorage;
};

const getBrowserLocation = (): Location => {
  if (typeof window === "undefined") {
    throw new Error("window.location is unavailable. Call this method in a browser.");
  }

  return window.location;
};

const getBrowserLocationHref = (): string => {
  return getBrowserLocation().href;
};

const getBrowserWindow = (): Window => {
  if (typeof window === "undefined") {
    throw new Error("window is unavailable. Call this method in a browser.");
  }

  return window;
};

const getBrowserDocument = (): Document => {
  if (typeof document === "undefined") {
    throw new Error("document is unavailable. Call this method in a browser.");
  }

  return document;
};

const createRequestId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const isProofSessionOperationMessage = (
  data: unknown,
  requestId: string,
): data is {
  type: typeof PROOF_SESSION_MESSAGE_TYPE;
  requestId: string;
  status: ProofSessionOperationStatus;
  message?: string;
} => {
  if (!data || typeof data !== "object") {
    return false;
  }

  const payload = data as {
    type?: unknown;
    requestId?: unknown;
    status?: unknown;
    message?: unknown;
  };

  return (
    payload.type === PROOF_SESSION_MESSAGE_TYPE &&
    payload.requestId === requestId &&
    (payload.status === "ready" ||
      payload.status === "expired" ||
      payload.status === "signed_out" ||
      payload.status === "error") &&
    (payload.message === undefined || typeof payload.message === "string")
  );
};

const isTransactionSignReadyMessage = (
  data: unknown,
  requestId: string,
): data is {
  type: typeof TRANSACTION_SIGN_READY_MESSAGE_TYPE;
  requestId: string;
} => {
  if (!data || typeof data !== "object") {
    return false;
  }
  const payload = data as { type?: unknown; requestId?: unknown };
  return payload.type === TRANSACTION_SIGN_READY_MESSAGE_TYPE && payload.requestId === requestId;
};

const parseTransactionSignResultMessage = (
  data: unknown,
  requestId: string,
):
  | {
      status: "signed";
      signed: IsolatedHostSignedTransaction;
    }
  | {
      status: "error";
      message?: string;
    }
  | null => {
  if (!data || typeof data !== "object") {
    return null;
  }
  const payload = data as {
    type?: unknown;
    requestId?: unknown;
    status?: unknown;
    signed?: unknown;
    message?: unknown;
  };
  if (payload.type !== TRANSACTION_SIGN_RESULT_MESSAGE_TYPE || payload.requestId !== requestId) {
    return null;
  }
  if (payload.status === "signed" && isSignedTransaction(payload.signed)) {
    return { status: "signed", signed: payload.signed };
  }
  if (payload.status === "error") {
    return {
      status: "error",
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    };
  }
  return {
    status: "error",
    message: "Invalid isolated-host signing response",
  };
};

const isSignedTransaction = (value: unknown): value is IsolatedHostSignedTransaction => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const signed = value as {
    transaction?: unknown;
    transactionEncoding?: unknown;
  };
  return (
    typeof signed.transaction === "string" &&
    (signed.transactionEncoding === undefined || typeof signed.transactionEncoding === "string")
  );
};
