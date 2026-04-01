import "./polyfills";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import { bootstrapAuthState } from "./states/bootstrap";
import { type StartOAuthInput, runStartOAuthFlow } from "./states/start-oauth";
import { authMachineReducer, initialAuthMachineState, type SwigAuthPhase } from "./states/states";
import { SwigSessionService } from "./swig-session/session-service";
import { DEFAULT_STORAGE_KEY, type PersistedSwigSession, resolveSwigSessionStore } from "./swig-session/session-store";
import {
  SwigApiClient,
  type ListProvidersResponse,
  type SwigBackendEndpoints,
} from "./transport/api";
import { Network, NetworkValue } from "./utils";

export type SessionStorageAdapter = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type SessionDataResponse = {
  configAddress: string;
  walletAddress: string;
  roleId: number;
};

const DEFAULT_BACKEND_API_URL = "https://backend.prod.infra.onswig.com";
const DEFAULT_ISOLATED_HOST_URL = "https://swig-dev-portal-isolated-host.vercel.app";
const DEFAULT_NETWORK = Network.Devnet;

export type SwigIdpConfig = {
  /** Optional override for the backend API base URL */
  baseUrl?: string;
  /** Optional override for the isolated host URL */
  isolatedHostUrl?: string;
  /** Deep link redirect URI for OAuth callbacks (e.g. "myapp://auth/callback") */
  redirectUri?: string;
  endpoints?: Partial<SwigBackendEndpoints>;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  storage?: SessionStorageAdapter;
  storageKey?: string;
  network?: NetworkValue
};

export type SwigIdpContextValue = {
  isReady: boolean;
  isAuthenticated: boolean;
  authPhase: SwigAuthPhase;
  /** All-in-one OAuth: opens browser, handles callback, returns session */
  startOAuth(input: StartOAuthInput): Promise<PersistedSwigSession>;
  /** Get persisted session data */
  getSession(): Promise<SessionDataResponse | null>;
  /** Clear session and log out */
  logout(): Promise<void>;
};

export type SwigIdpProviderProps = {
  config: SwigIdpConfig;
  children: ReactNode;
};

export type {
  GetSwigStatusRequest,
  GetSwigStatusResponse,
  ListProvidersRequest,
  ListProvidersResponse,
  SwigBackendEndpoints,
} from "./transport/api";

export const SwigIdpContext = createContext<SwigIdpContextValue | undefined>(undefined);

export function SwigIdpProvider({ config, children }: SwigIdpProviderProps): ReactNode {
  const [state, dispatch] = useReducer(authMachineReducer, initialAuthMachineState);
  const resolvedConfig = useMemo(
    () => ({
      ...config,
      baseUrl: config.baseUrl ?? DEFAULT_BACKEND_API_URL,
      network: config.network ?? DEFAULT_NETWORK,
    }),
    [config],
  );
  const isolatedHostUrl = resolvedConfig.isolatedHostUrl ?? DEFAULT_ISOLATED_HOST_URL;

  const api = useMemo(() => new SwigApiClient(resolvedConfig), [resolvedConfig]);
  const sessionStore = useMemo(
    () => resolveSwigSessionStore(resolvedConfig.storage, resolvedConfig.storageKey ?? DEFAULT_STORAGE_KEY),
    [resolvedConfig.storage, resolvedConfig.storageKey],
  );
  const sessionService = useMemo(() => new SwigSessionService(sessionStore), [sessionStore]);

  useEffect(() => {
    void bootstrapAuthState({ sessionService, dispatch });
  }, [sessionService]);

  const startOAuth = useCallback(
    async (input: Omit<StartOAuthInput, "network">) => {
      if (!resolvedConfig.redirectUri) {
        throw new Error("redirectUri must be set in SwigIdpConfig to use startOAuth");
      }
      if (!resolvedConfig.network) {
        throw new Error("Network not set");
      }
      return runStartOAuthFlow({
        input: { ...input, network: resolvedConfig.network },
        redirectUri: resolvedConfig.redirectUri,
        isolatedHostUrl,
        api,
        sessionService,
        dispatch,
      });
    },
    [api, resolvedConfig.redirectUri, isolatedHostUrl, sessionService],
  );

  const listProviders = useCallback(
    async (input: { clientId: string }): Promise<ListProvidersResponse> => {
      return api.listProviders({ client_id: input.clientId });
    },
    [api],
  );

  const getSession = useCallback(async (): Promise<SessionDataResponse | null> => {
    const persisted = await sessionService.load();
    if (!persisted) return null;
    return {
      configAddress: persisted.configAddress,
      walletAddress: persisted.walletAddress,
      roleId: persisted.roleId,
    };
  }, [sessionService]);

  const logout = useCallback(async (): Promise<void> => {
    await sessionService.clear();
    dispatch({ type: "LOGOUT_DONE" });
  }, [sessionService]);

  const value = useMemo<SwigIdpContextValue>(
    () => ({
      isReady: state.isReady,
      isAuthenticated: state.isAuthenticated,
      authPhase: state.phase,
      startOAuth,
      getSession,
      listProviders,
      logout,
    }),
    [getSession, listProviders, logout, startOAuth, state.isAuthenticated, state.isReady, state.phase],
  );

  return (
    <SwigIdpContext.Provider value={value}>
      {children}
    </SwigIdpContext.Provider>
  );
}
