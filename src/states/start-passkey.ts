import { openAuthSessionAsync } from "expo-web-browser";
import { type NetworkValue } from "../utils.js";
import type { SwigSessionService } from "../swig-session/session-service.js";
import type { PersistedSwigSession } from "../swig-session/session-store.js";
import type { AuthDispatch } from "./states.js";
import { parseOAuthCallbackUrl } from "./oauth-callback.js";

export type StartPasskeyInput = {
  /** Developer's client ID. */
  clientId: string;
  /** Policy ID for role flow. */
  policyId?: string;
  /** Opaque developer state value, round-tripped via the backend. */
  clientState?: string;
  /** Solana network. Injected by the provider when not supplied. */
  network: NetworkValue;
};

export const runStartPasskeyFlow = async ({
  input,
  redirectUri,
  isolatedHostUrl,
  sessionService,
  dispatch,
}: {
  input: StartPasskeyInput;
  redirectUri: string;
  isolatedHostUrl: string;
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
}): Promise<PersistedSwigSession> => {
  dispatch({ type: "BEGIN_OAUTH" });

  const ihUrl = buildIsolatedHostPasskeyUrl({ isolatedHostUrl, redirectUri, input });
  const result = await openAuthSessionAsync(ihUrl, redirectUri);
  if (result.type !== "success" || !("url" in result)) {
    dispatch({ type: "ERROR", message: "Passkey flow was cancelled" });
    throw new Error("Passkey flow was cancelled");
  }

  const session = parseOAuthCallbackUrl(result.url);
  await sessionService.save(session);

  dispatch({ type: "AUTHENTICATED" });
  return session;
};

function buildIsolatedHostPasskeyUrl({
  isolatedHostUrl,
  redirectUri,
  input,
}: {
  isolatedHostUrl: string;
  redirectUri: string;
  input: StartPasskeyInput;
}): string {
  const base = isolatedHostUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();

  params.set("client_id", input.clientId);
  params.set("network", String(input.network));
  params.set("redirect_uri", redirectUri);

  if (input.policyId) params.set("policy_id", input.policyId);
  if (input.clientState) params.set("client_state", input.clientState);

  return `${base}/passkey?${params.toString()}`;
}
