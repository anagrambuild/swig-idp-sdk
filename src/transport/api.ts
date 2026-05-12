import { NetworkValue } from "../utils.js";
import type { SwigIdpConfig } from "../provider.js";

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
  network: NetworkValue;
  flow?: "role" | "session";
  policy_id?: string;
  authority_public_key?: string;
  role_intent?: "agent";
  agent_name?: string;
};

export type StartAuthResponse = {
  redirectUrl: string;
  state: string;
  startToken?: string;
};

export type SignupRequest = {
  client_id: string;
  zk_proof: string;
  network: NetworkValue;
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
  network: NetworkValue;
};

export type CreateSessionResponse = {
  status: string;
  role_id: number;
  signature: string;
};

export type ListAgentsRequest = {
  client_id: string;
  swig_pubkey: string;
  network: NetworkValue;
};

export type AgentInfo = {
  authority_public_key?: string;
  authorityPublicKey?: string;
  role_id?: number;
  roleId?: number;
  reputation_score?: number;
  reputationScore?: number;
  label?: string;
  swig_pubkey?: string;
  swigPubkey?: string;
  wallet_address?: string;
  walletAddress?: string;
  created_at?: string;
  createdAt?: string;
};

export type ListAgentsResponse = {
  agents: AgentInfo[];
};

export type UpdateAgentReputationRequest = {
  client_id: string;
  swig_pubkey: string;
  network: NetworkValue;
  role_id: number;
  reputation_score: number;
};

export type UpdateAgentReputationResponse = {
  status: string;
  reputation_score?: number;
  reputationScore?: number;
};

export type RemoveRoleRequest = {
  client_id: string;
  zk_proof: string;
  role_id: number;
  network: NetworkValue;
};

export type RemoveRoleResponse = {
  status: string;
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
  listAgents: string;
  updateAgentReputation: string;
  removeRole: string;
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
  listAgents: "/identity/api/agents",
  updateAgentReputation: "/identity/api/agents/reputation",
  removeRole: "/identity/api/role-remove",
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

const decodeGrpcMessage = (message: string | null): string | null => {
  if (!message) {
    return null;
  }

  try {
    return decodeURIComponent(message.replace(/\+/g, "%20"));
  } catch {
    return message;
  }
};

const getGrpcError = (method: string, response: Response): Error | null => {
  const grpcStatus = response.headers.get("grpc-status");
  if (!grpcStatus || grpcStatus === "0") {
    return null;
  }

  const grpcMessage = decodeGrpcMessage(response.headers.get("grpc-message"));
  const message = grpcMessage ? `: ${grpcMessage}` : "";
  return new Error(`Swig API ${method} failed (grpc ${grpcStatus})${message}`);
};

const readJsonResponse = async <TResponse>(
  method: string,
  response: Response,
): Promise<TResponse> => {
  const grpcError = getGrpcError(method, response);
  if (grpcError) {
    throw grpcError;
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Swig API ${method} returned an empty response`);
  }

  try {
    return JSON.parse(text) as TResponse;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Swig API ${method} returned invalid JSON: ${reason}`);
  }
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

    const grpcError = getGrpcError("GET", response);
    if (grpcError) {
      throw grpcError;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Swig API GET failed (${response.status}): ${text}`);
    }

    return readJsonResponse<TResponse>("GET", response);
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

    const grpcError = getGrpcError("POST", response);
    if (grpcError) {
      throw grpcError;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Swig API POST failed (${response.status}): ${text}`);
    }

    return readJsonResponse<TResponse>("POST", response);
  }

  private async patch<TResponse>(path: string, body: Record<string, unknown>): Promise<TResponse> {
    const response = await this.fetchImpl(joinUrl(this.config.baseUrl, path), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.defaultHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });

    const grpcError = getGrpcError("PATCH", response);
    if (grpcError) {
      throw grpcError;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Swig API PATCH failed (${response.status}): ${text}`);
    }

    return readJsonResponse<TResponse>("PATCH", response);
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

  listAgents(input: ListAgentsRequest): Promise<ListAgentsResponse> {
    return this.get<ListAgentsResponse>(this.endpoints.listAgents, input);
  }

  updateAgentReputation(
    input: UpdateAgentReputationRequest,
  ): Promise<UpdateAgentReputationResponse> {
    return this.patch<UpdateAgentReputationResponse>(
      this.endpoints.updateAgentReputation,
      input,
    );
  }

  removeRole(input: RemoveRoleRequest): Promise<RemoveRoleResponse> {
    return this.post<RemoveRoleResponse>(this.endpoints.removeRole, input);
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
