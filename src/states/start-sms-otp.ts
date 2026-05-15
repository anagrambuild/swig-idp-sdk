import { openAuthSessionAsync } from "expo-web-browser";
import { type NetworkValue } from "../utils.js";
import type { SwigSessionService } from "../swig-session/session-service.js";
import type { AuthDispatch } from "./states.js";
import type { PersistedSwigSession } from "../swig-session/session-store.js";
import { parseOAuthCallbackUrl } from "./oauth-callback.js";

export type StartSmsOtpInput = {
  /**
   * SMS-OTP provider key. Defaults to "sms"; an explicit value lets tenants
   * register their own sms-otp provider (e.g. "tenant_acme_sms").
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
   * Optional human-readable label rendered above the phone input on the IH
   * (e.g. the dev app's name). Defaults to nothing — the IH falls back to a
   * generic prompt.
   */
  appLabel?: string;
  /** Solana network. Injected by the provider when not supplied. */
  network: NetworkValue;
};

const DEFAULT_SMS_OTP_PROVIDER = "sms";

/**
 * All-in-one SMS-OTP flow for mobile.
 *
 * Mirror of runStartEmailOtpFlow that routes through the isolated host's
 * phone-entry page (`/callback/sms-otp/start`). The user types their phone
 * number on the IH — the developer app never sees it. The IH then calls the
 * same /identity/api/auth/sms/start endpoint and hands off to the existing
 * OTP entry page; from there the flow is identical to OAuth (verify ->
 * /callback -> ZK proof + add_role -> deep link back).
 *
 * The session payload returned here is therefore byte-identical to the
 * OAuth and email-OTP flow payloads; the choice of channel is invisible to
 * consumers after this call resolves.
 */
export const runStartSmsOtpFlow = async ({
  input,
  redirectUri,
  isolatedHostUrl,
  sessionService,
  dispatch,
}: {
  input: StartSmsOtpInput;
  redirectUri: string;
  isolatedHostUrl: string;
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
}): Promise<PersistedSwigSession> => {
  dispatch({ type: "BEGIN_OAUTH" });

  const ihUrl = buildIsolatedHostStartUrl({ isolatedHostUrl, redirectUri, input });

  // Open a system auth session (NOT an embedded WebView). The host app must
  // not be able to inspect the IH DOM, URLs, or storage. The IH phone-entry
  // page collects the number and runs through verify; only the final deep
  // link back to redirectUri carries the session params we need below.
  const result = await openAuthSessionAsync(ihUrl, redirectUri);
  if (result.type !== "success" || !("url" in result)) {
    dispatch({ type: "ERROR", message: "SMS OTP flow was cancelled" });
    throw new Error("SMS OTP flow was cancelled");
  }

  const session = parseOAuthCallbackUrl(result.url);
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
  input: StartSmsOtpInput;
}): string {
  const base = isolatedHostUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("provider", input.provider ?? DEFAULT_SMS_OTP_PROVIDER);
  params.set("clientId", input.clientId);
  params.set("redirectUri", redirectUri);
  params.set("network", String(input.network));
  params.set("flow", input.flow ?? "role");
  if (input.policyId) params.set("policyId", input.policyId);
  if (input.state) params.set("state", input.state);
  if (input.appLabel) params.set("appLabel", input.appLabel);
  return `${base}/callback/sms-otp/start?${params.toString()}`;
}
