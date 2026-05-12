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
      return session;
    } catch {
      await this.clear();
      return null;
    }
  }

  async save(session: PersistedSwigSession): Promise<void> {
    await this.storage.setItem(this.storageKey, JSON.stringify(session));
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
