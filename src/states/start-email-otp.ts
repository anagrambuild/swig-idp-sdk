import { openAuthSessionAsync } from "expo-web-browser";
import { type NetworkValue } from "../utils";
import type { SwigSessionService } from "../swig-session/session-service";
import type { AuthDispatch } from "./states";
import type { PersistedSwigSession } from "../swig-session/session-store";

export type StartEmailOtpInput = {
  /**
   * Email-OTP provider key. Defaults to "email"; an explicit value lets
   * tenants register their own email-otp provider (e.g. "tenant_acme_email").
   */
  provider?: string;
  /** Developer's client ID. */
  clientId: string;
  /** Flow type: role (mobile + web) or session (web only). */
  flow?: "role" | "session";
  /** Policy ID for role flow. */
  policyId?: string;
  /**
   * Opaque developer state value, round-tripped through the IH back to the
   * deep-link callback. Useful if the host app needs to correlate the auth
   * session with some local context.
   */
  state?: string;
  /**
   * Optional human-readable label rendered above the email input on the IH
   * (e.g. the dev app's name). Defaults to nothing — the IH falls back to a
   * generic prompt.
   */
  appLabel?: string;
  /** Solana network. Injected by the provider when not supplied. */
  network: NetworkValue;
};

const DEFAULT_EMAIL_OTP_PROVIDER = "email";

/**
 * All-in-one email-OTP flow for mobile.
 *
 * Mirrors runStartOAuthFlow shape but routes through the isolated host's
 * email-entry page (`/callback/email-otp/start`). The user types their
 * address on the IH — the developer app never sees it. The IH then calls
 * the same /identity/api/auth/email/start endpoint and hands off to the
 * existing OTP entry page; from there the flow is identical to OAuth
 * (verify -> /callback -> ZK proof + add_role -> deep link back).
 *
 * The session payload returned here is therefore byte-identical to the
 * OAuth flow's payload; the choice of provider is invisible to consumers
 * after this call resolves.
 */
export const runStartEmailOtpFlow = async ({
  input,
  redirectUri,
  isolatedHostUrl,
  sessionService,
  dispatch,
}: {
  input: StartEmailOtpInput;
  redirectUri: string;
  isolatedHostUrl: string;
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
}): Promise<PersistedSwigSession> => {
  dispatch({ type: "BEGIN_OAUTH" });

  const ihUrl = buildIsolatedHostStartUrl({ isolatedHostUrl, redirectUri, input });

  // Open a system auth session (NOT an embedded WebView). The host app must
  // not be able to inspect the IH DOM, URLs, or storage. The IH email-entry
  // page collects the address and runs through verify; only the final deep
  // link back to redirectUri carries the session params we need below.
  const result = await openAuthSessionAsync(ihUrl, redirectUri);
  if (result.type !== "success" || !("url" in result)) {
    dispatch({ type: "ERROR", message: "Email OTP flow was cancelled" });
    throw new Error("Email OTP flow was cancelled");
  }

  const session = parseSessionFromCallback(result.url);
  await sessionService.save(session);

  dispatch({ type: "AUTHENTICATED" });
  return session;
};

function buildIsolatedHostStartUrl({
  isolatedHostUrl,
  redirectUri,
  input,
}: {
  isolatedHostUrl: string;
  redirectUri: string;
  input: StartEmailOtpInput;
}): string {
  const base = isolatedHostUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("provider", input.provider ?? DEFAULT_EMAIL_OTP_PROVIDER);
  params.set("clientId", input.clientId);
  params.set("redirectUri", redirectUri);
  params.set("network", String(input.network));
  params.set("flow", input.flow ?? "role");
  if (input.policyId) params.set("policyId", input.policyId);
  if (input.state) params.set("state", input.state);
  if (input.appLabel) params.set("appLabel", input.appLabel);
  return `${base}/callback/email-otp/start?${params.toString()}`;
}

/**
 * Parse session data from the IH deep-link callback. The IH already ran the
 * OTP verify + ZK proof + add_role flow — we just extract the results. Kept
 * inline (rather than imported from start-oauth) so the two flows stay
 * independently testable.
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
    throw new Error(
      "Missing required callback params: swig_pubkey, wallet_address, or role_id",
    );
  }

  return {
    configAddress,
    walletAddress,
    roleId: Number(roleId),
    authFlow: "role",
    updatedAt: Date.now(),
  };
}
