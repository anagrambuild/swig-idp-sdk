import type { SwigIdpConfig } from "../provider";

type SwigApiClientConfig = Pick<
  SwigIdpConfig,
  "defaultHeaders" | "endpoints" | "fetch"
> & {
  baseUrl: string;
};

export type ListProvidersRequest = {
  client_id: string;
};

export type ProviderLoginOption = {
  id: string;
  label: string;
  scopes: string[];
};

export type ProviderInfo = {
  key: string;
  label: string;
  provider_type: string;
  default_scopes: string[];
  options: ProviderLoginOption[];
};

export type ListProvidersResponse = {
  providers: ProviderInfo[];
};

export type StartAuthRequest = {
  provider: string;
  client_id: string;
  redirect_uri: string;
  state: string;
};

export type StartAuthResponse = {
  redirectUrl: string;
  state: string;
};

export type SignupRequest = {
  client_id: string;
  zk_proof: string;
  network: string;
};

export type SignupResponse = {
  status: string;
  swig_pubkey: string;
  wallet_address: string;
  signature: string;
};

export type CreateSessionRequest = {
  client_id: string;
  swig_pubkey: string;
  zk_proof: string;
  session_key: string;
  duration: number;
  network: string;
};

export type CreateSessionResponse = {
  status: string;
  role_id: number;
  signature: string;
};

export type LookupSwigRequest = {
  client_id: string;
  identifier: string;
};

export type LookupSwigResponse = {
  swig_id: string;
  wallet_address: string;
  found: boolean;
};

export type GetSwigStatusRequest = {
  client_id: string;
  subject: string;
};

export type GetSwigStatusResponse = {
  exists: boolean;
  swig_id: string;
};

export type CheckSwigAuthRequest = {
  client_id: string;
  swig_id: string;
};

export type CheckSwigAuthResponse = {
  authorized: boolean;
  reason: string;
};

export type CreateSwigSessionRequest = {
  swig_id: string;
  role_template_id: string;
};

export type CreateSwigSessionResponse = {
  session_authority: string;
  session_token: string;
};

export type GetPolicyRequest = {
  policy_id: string;
};

export type GetPolicyResponse = {
  policy_json: string;
};

export type SwigBackendEndpoints = {
  listProviders: string;
  startAuth: string;
  signup: string;
  createSession: string;
  lookupSwig: string;
  getSwigStatus: string;
  checkSwigAuth: string;
  createSwigSession: string;
  getPolicy: string;
};

const DEFAULT_ENDPOINTS: SwigBackendEndpoints = {
  listProviders: "/identity/api/providers",
  startAuth: "/identity/api/auth/start",
  signup: "/identity/api/signup",
  createSession: "/identity/api/session",
  lookupSwig: "/wallet/swig/lookup",
  getSwigStatus: "/wallet/swig/status",
  checkSwigAuth: "/wallet/swig/auth/check",
  createSwigSession: "/wallet/swig/session",
  getPolicy: "/wallet/policies/{policy_id}",
};

const joinUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
};

const toQueryString = (params: Record<string, unknown>): string => {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }

    search.set(key, String(value));
  }

  const query = search.toString();
  return query.length > 0 ? `?${query}` : "";
};

export class SwigApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: SwigBackendEndpoints;

  constructor(private readonly config: SwigApiClientConfig) {
    this.fetchImpl = config.fetch ?? fetch;
    this.endpoints = {
      ...DEFAULT_ENDPOINTS,
      ...config.endpoints,
    };
  }

  private async get<TResponse>(path: string, params?: Record<string, unknown>): Promise<TResponse> {
    const query = params ? toQueryString(params) : "";

    const response = await this.fetchImpl(`${joinUrl(this.config.baseUrl, path)}${query}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.defaultHeaders ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Swig API GET failed (${response.status}): ${text}`);
    }

    return (await response.json()) as TResponse;
  }

  private async post<TResponse>(path: string, body: Record<string, unknown>): Promise<TResponse> {
    // TODO(SWI-289):
    // Keep this layer transport-only. Avoid proof and session orchestration here.
    const response = await this.fetchImpl(joinUrl(this.config.baseUrl, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.defaultHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Swig API POST failed (${response.status}): ${text}`);
    }

    return (await response.json()) as TResponse;
  }

  // api_idp.proto
  listProviders(input: ListProvidersRequest): Promise<ListProvidersResponse> {
    return this.get<ListProvidersResponse>(this.endpoints.listProviders, input);
  }

  startAuth(input: StartAuthRequest): Promise<StartAuthResponse> {
    return this.get<StartAuthResponse>(this.endpoints.startAuth, input);
  }

  signup(input: SignupRequest): Promise<SignupResponse> {
    return this.post<SignupResponse>(this.endpoints.signup, input);
  }

  createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.post<CreateSessionResponse>(this.endpoints.createSession, input);
  }

  // api_wallet.proto
  lookupSwig(input: LookupSwigRequest): Promise<LookupSwigResponse> {
    return this.post<LookupSwigResponse>(this.endpoints.lookupSwig, input);
  }

  getSwigStatus(input: GetSwigStatusRequest): Promise<GetSwigStatusResponse> {
    return this.get<GetSwigStatusResponse>(this.endpoints.getSwigStatus, input);
  }

  checkSwigAuth(input: CheckSwigAuthRequest): Promise<CheckSwigAuthResponse> {
    return this.post<CheckSwigAuthResponse>(this.endpoints.checkSwigAuth, input);
  }

  createSwigSession(input: CreateSwigSessionRequest): Promise<CreateSwigSessionResponse> {
    return this.post<CreateSwigSessionResponse>(this.endpoints.createSwigSession, input);
  }

  getPolicy(input: GetPolicyRequest): Promise<GetPolicyResponse> {
    const path = this.endpoints.getPolicy.replace(
      "{policy_id}",
      encodeURIComponent(input.policy_id),
    );
    return this.get<GetPolicyResponse>(path);
  }
}
