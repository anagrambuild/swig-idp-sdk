import { openAuthSessionAsync } from "expo-web-browser";
import { type NetworkValue } from "../utils.js";
import type { SwigApiClient } from "../transport/api.js";
import type { SwigSessionService } from "../swig-session/session-service.js";
import type { AuthDispatch } from "./states.js";
import type { PersistedSwigSession } from "../swig-session/session-store.js";
import {
  buildIsolatedHostStartUrl,
  parseOAuthCallbackUrl,
} from "./oauth-callback.js";

export type StartOAuthInput = {
  /** OAuth provider key (e.g. "google", "demo-oidc") */
  provider: string;
  /** Developer's client ID */
  clientId: string;
  /** Flow type: role (mobile+web) or session (web only) */
  flow?: "role" | "session";
  /** Policy ID for role flow */
  policyId?: string;
  /** Optional Ed25519 public key to add as the role authority. */
  authorityPublicKey?: string;
  /** Optional role intent used by One Wallet agent connect. */
  roleIntent?: "agent";
  /** Optional agent display name for agent role additions. */
  agentName?: string;
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

  // 1. Begin auth → get a trusted start token from the backend
  const { redirectUrl, startToken, state: nonce } = await api.startAuth({
    provider: input.provider,
    client_id: input.clientId,
    redirect_uri: redirectUri,
    state: "",
    network: input.network,
    flow: input.flow ?? "role",
    ...(input.policyId ? { policy_id: input.policyId } : {}),
    ...(input.authorityPublicKey ? { authority_public_key: input.authorityPublicKey } : {}),
    ...(input.roleIntent ? { role_intent: input.roleIntent } : {}),
    ...(input.agentName ? { agent_name: input.agentName } : {}),
  });

  // 2. Build IH /start URL with the trusted token when available.
  const ihStartUrl = buildIsolatedHostStartUrl({
    isolatedHostUrl,
    redirectUri,
    redirectUrl,
    nonce,
    flow: input.flow ?? "role",
    clientId: input.clientId,
    ...(startToken ? { startToken } : {}),
    ...(input.policyId ? { policyId: input.policyId } : {}),
    ...(input.authorityPublicKey ? { authorityPublicKey: input.authorityPublicKey } : {}),
    ...(input.roleIntent ? { roleIntent: input.roleIntent } : {}),
    ...(input.agentName ? { agentName: input.agentName } : {}),
  });

  // 3. Open a system auth session. Embedded WebViews are intentionally unsupported
  // because the host app can inspect DOM, URLs, and storage for the isolated host.
  const result = await openAuthSessionAsync(ihStartUrl, redirectUri);
  if (result.type !== "success" || !("url" in result)) {
    dispatch({ type: "ERROR", message: "OAuth flow was cancelled" });
    throw new Error("OAuth flow was cancelled");
  }

  // 4. Parse session data from deep link (no JWT — just swig_pubkey, role_id, etc.)
  const session = parseOAuthCallbackUrl(result.url);
  // 5. Persist session
  await sessionService.save(session);

  dispatch({ type: "AUTHENTICATED" });
  return session;
};
