import { openAuthSessionAsync } from "expo-web-browser";
import { type NetworkValue } from "../utils";
import type { SwigApiClient } from "../transport/api";
import type { SwigSessionService } from "../swig-session/session-service";
import type { AuthDispatch } from "./states";
import type { PersistedSwigSession } from "../swig-session/session-store";

export type StartOAuthInput = {
  /** OAuth provider key (e.g. "google", "demo-oidc") */
  provider: string;
  /** Developer's client ID */
  clientId: string;
  /** Flow type: role (mobile+web) or session (web only) */
  flow?: "role" | "session";
  /** Policy ID for role flow */
  policyId?: string;
  /** Solana network (default: Network.Devnet) */
  network: NetworkValue;
};

/**
 * All-in-one OAuth flow for mobile.
 *
 * Routes through IH /start → IDP → IH /callback (ZK proof + approval + add_role) → deep link.
 * The IH handles everything — JWT never leaves the IH domain.
 * Returns session data parsed from the deep link callback.
 */
export const runStartOAuthFlow = async ({
  input,
  redirectUri,
  isolatedHostUrl,
  api,
  sessionService,
  dispatch,
}: {
  input: StartOAuthInput;
  redirectUri: string;
  isolatedHostUrl: string;
  api: SwigApiClient;
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
}): Promise<PersistedSwigSession> => {
  dispatch({ type: "BEGIN_OAUTH" });

  // 1. Begin auth → get redirect URL and nonce from backend
  const { redirectUrl, state: nonce } = await api.startAuth({
    provider: input.provider,
    client_id: input.clientId,
    redirect_uri: redirectUri,
    state: "",
    network: input.network,
  });

  // 2. Build IH /start URL with all params
  const flow = input.flow ?? "role";
  const startParams = new URLSearchParams({
    nonce,
    oauth_redirect: redirectUrl,
    redirect_uri: redirectUri,
    flow,
    client_id: input.clientId,
  });
  if (input.policyId) {
    startParams.set("policy_id", input.policyId);
  }
  const ihStartUrl = `${isolatedHostUrl}/start?${startParams.toString()}`;

  // 3. Open system browser — IH handles OAuth, ZK proof, approval, add_role
  const result = await openAuthSessionAsync(ihStartUrl, redirectUri);
  if (result.type !== "success" || !("url" in result)) {
    dispatch({ type: "ERROR", message: "OAuth flow was cancelled" });
    throw new Error("OAuth flow was cancelled");
  }

  // 4. Parse session data from deep link (no JWT — just swig_pubkey, role_id, etc.)
  const session = parseSessionFromCallback(result.url);
  // 5. Persist session
  await sessionService.save(session);

  dispatch({ type: "AUTHENTICATED" });
  return session;
};

/**
 * Parse session data from the IH callback deep link.
 * The IH already did all the work — we just extract the results.
 */
function parseSessionFromCallback(url: string): PersistedSwigSession {
  const params = new URL(url).searchParams;

  const error = params.get("error");
  if (error) {
    throw new Error(params.get("error_description") ?? error);
  }

  const configAddress = params.get("swig_pubkey");
  const walletAddress = params.get("wallet_address");
  const roleId = params.get("role_id");

  if (!configAddress || !walletAddress || !roleId) {
    throw new Error("Missing required callback params: swig_pubkey, wallet_address, or role_id");
  }

  return {
    configAddress,
    walletAddress,
    roleId: Number(roleId),
    authFlow: "role",
    updatedAt: Date.now(),
  };
}
