import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { DEFAULT_ISOLATED_HOST_URL } from "./config.js";
import {
  SwigEmbedded,
  SwigEmbeddedError,
  connectSwigEmbedded,
  type EmbeddedSession,
  type EmbeddedUiState,
  type RoleOperationResult,
} from "./embedded.js";
import { Network, type NetworkValue } from "./utils.js";

/**
 * React binding for the embedded Swig isolated-host client.
 *
 * Wrap your app in `<SwigWebProvider clientId="…">` and consume `useSwigWeb()`.
 * The provider owns the persistent isolated-host iframe, reflects its session
 * and UI state into React, and renders the consent iframe as a modal when the
 * isolated host needs the user (add/remove role, etc.). Login/consent all run
 * inside the isolated host — this app never sees the JWT.
 */

export type SwigWebEnv = "local" | "prod";

/**
 * URL presets by environment. The clientId is always supplied as a prop. The
 * embedded client talks only to the isolated host (which knows its own
 * backend), so only the IH URL is needed here.
 */
const ENV_PRESETS: Record<SwigWebEnv, { isolatedHostUrl: string }> = {
  local: {
    isolatedHostUrl: "http://localhost:5174",
  },
  prod: {
    isolatedHostUrl: DEFAULT_ISOLATED_HOST_URL,
  },
};

export type SwigWebProviderProps = {
  /** Developer's client ID. */
  clientId: string;
  /** URL preset. Individual URL props override the preset. Defaults to "prod". */
  env?: SwigWebEnv;
  isolatedHostUrl?: string;
  network?: NetworkValue;
  /** Registered callback URL. Defaults to `${location.origin}/auth/callback`. */
  redirectUri?: string;
  /** Skip the default consent-modal inline styling; style via className props. */
  unstyled?: boolean;
  /** Extra class on the modal backdrop (applied when the IH surface is shown). */
  backdropClassName?: string;
  /** Extra class on the modal card that holds the iframe. */
  cardClassName?: string;
  children: ReactNode;
};

export type SwigWebContextValue = {
  /** False until the isolated host iframe has connected. */
  isReady: boolean;
  isAuthenticated: boolean;
  session: EmbeddedSession | null;
  /** IH UI state — "consent"/"busy" surface the modal; "idle" hides it. */
  uiState: EmbeddedUiState;
  error: string | null;
  /** The underlying embedded client (escape hatch), or null until ready. */
  client: SwigEmbedded | null;
  /** MUST be called synchronously from a click (opens the OAuth popup). */
  login: (provider: string) => Promise<EmbeddedSession>;
  logout: () => Promise<void>;
  /** Add a policy role — user approves in the SDK-rendered consent modal. */
  addRole: (policyId: string) => Promise<RoleOperationResult>;
  /** Remove a role — user approves in the SDK-rendered consent modal. */
  removeRole: (roleId: number, roleName?: string) => Promise<RoleOperationResult>;
};

const SwigWebContext = createContext<SwigWebContextValue | undefined>(undefined);

export function SwigWebProvider({
  clientId,
  env = "prod",
  isolatedHostUrl,
  network = Network.Devnet,
  redirectUri,
  unstyled,
  backdropClassName,
  cardClassName,
  children,
}: SwigWebProviderProps): ReactNode {
  const preset = ENV_PRESETS[env];
  const resolvedIsolatedHostUrl = isolatedHostUrl ?? preset.isolatedHostUrl;

  const containerRef = useRef<HTMLDivElement>(null);
  const [client, setClient] = useState<SwigEmbedded | null>(null);
  const [session, setSession] = useState<EmbeddedSession | null>(null);
  const [uiState, setUiState] = useState<EmbeddedUiState>("idle");
  const [error, setError] = useState<string | null>(null);

  // Mount the persistent isolated-host iframe; reconnect on config change.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let instance: SwigEmbedded | null = null;
    const unsubscribers: Array<() => void> = [];

    connectSwigEmbedded({
      clientId,
      ...(redirectUri ? { redirectUri } : {}),
      isolatedHostUrl: resolvedIsolatedHostUrl,
      network,
      container: containerRef.current,
    })
      .then((connected) => {
        if (cancelled) {
          connected.destroy();
          return;
        }
        instance = connected;
        setClient(connected);
        setSession(connected.session);
        setError(null);
        unsubscribers.push(connected.onSessionChanged((next) => setSession(next)));
        unsubscribers.push(connected.onUiState((state) => setUiState(state)));
      })
      .catch((connectError: unknown) => {
        if (!cancelled) {
          setError(
            connectError instanceof Error
              ? connectError.message
              : "Failed to connect to the isolated host",
          );
        }
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      instance?.destroy();
      setClient(null);
      setSession(null);
      setUiState("idle");
    };
  }, [clientId, resolvedIsolatedHostUrl, network, redirectUri]);

  const login = useCallback(
    (provider: string): Promise<EmbeddedSession> => {
      if (!client) {
        return Promise.reject(
          new SwigEmbeddedError("not_ready", "Isolated host is not connected yet"),
        );
      }
      // No awaits before this call — the popup needs the click's activation.
      return client.login(provider);
    },
    [client],
  );

  const logout = useCallback(async () => {
    if (client) await client.logout();
    setError(null);
  }, [client]);

  const addRole = useCallback(
    (policyId: string) => {
      if (!client) {
        return Promise.reject(new SwigEmbeddedError("not_ready", "Isolated host not connected"));
      }
      return client.addRole(policyId);
    },
    [client],
  );

  const removeRole = useCallback(
    (roleId: number, roleName?: string) => {
      if (!client) {
        return Promise.reject(new SwigEmbeddedError("not_ready", "Isolated host not connected"));
      }
      return client.removeRole(roleId, roleName);
    },
    [client],
  );

  const value = useMemo<SwigWebContextValue>(
    () => ({
      isReady: client !== null,
      isAuthenticated: session !== null,
      session,
      uiState,
      error,
      client,
      login,
      logout,
      addRole,
      removeRole,
    }),
    [client, session, uiState, error, login, logout, addRole, removeRole],
  );

  const surfaceVisible = uiState === "consent" || uiState === "busy";

  return (
    <SwigWebContext.Provider value={value}>
      {children}
      <SwigConsentSurface
        containerRef={containerRef}
        visible={surfaceVisible}
        unstyled={unstyled}
        backdropClassName={backdropClassName}
        cardClassName={cardClassName}
      />
    </SwigWebContext.Provider>
  );
}

export const useSwigWeb = (): SwigWebContextValue => {
  const context = useContext(SwigWebContext);
  if (!context) {
    throw new Error("useSwigWeb must be used within a SwigWebProvider");
  }
  return context;
};

// Re-export the surface an app needs so everything comes from one import path.
export { Network, SwigEmbedded, SwigEmbeddedError };
export type {
  EmbeddedSession,
  EmbeddedUiState,
  NetworkValue,
  RoleOperationResult,
};

/**
 * Holds the isolated-host iframe. The container is rendered ONCE and never
 * unmounted (unmounting would reload the iframe and drop the session); it is
 * shown as a centered modal when the IH needs the user and hidden with CSS
 * otherwise.
 */
function SwigConsentSurface({
  containerRef,
  visible,
  unstyled,
  backdropClassName,
  cardClassName,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  unstyled: boolean | undefined;
  backdropClassName: string | undefined;
  cardClassName: string | undefined;
}): ReactNode {
  // Hidden state keeps the iframe mounted but invisible and non-interactive.
  const hiddenBackdrop: CSSProperties = {
    position: "fixed",
    width: 0,
    height: 0,
    overflow: "hidden",
    opacity: 0,
    pointerEvents: "none",
    border: 0,
  };
  const shownBackdrop: CSSProperties = {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(15, 23, 42, 0.4)",
    backdropFilter: "blur(4px)",
    zIndex: 2147483000,
  };
  const shownCard: CSSProperties = {
    width: "100%",
    maxWidth: 420,
    height: 560,
    overflow: "hidden",
    background: "#ffffff",
    borderRadius: 16,
    border: "1px solid #e2e8f0",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
  };

  const backdropStyle = !visible ? hiddenBackdrop : unstyled ? undefined : shownBackdrop;
  const cardStyle = !visible || unstyled ? undefined : shownCard;

  return (
    <div style={backdropStyle} className={visible ? backdropClassName : undefined}>
      <div ref={containerRef} style={cardStyle} className={visible ? cardClassName : undefined} />
    </div>
  );
}
