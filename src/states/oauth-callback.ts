import type { PersistedSwigSession } from "../swig-session/session-store.js";

export type BuildIsolatedHostStartUrlInput = {
  isolatedHostUrl: string;
  redirectUri: string;
  redirectUrl: string;
  nonce: string;
  flow: "role" | "session";
  clientId: string;
  startToken?: string;
  policyId?: string;
};

export const buildIsolatedHostStartUrl = ({
  isolatedHostUrl,
  redirectUri,
  redirectUrl,
  nonce,
  flow,
  clientId,
  startToken,
  policyId,
}: BuildIsolatedHostStartUrlInput): string => {
  const startParams = new URLSearchParams();

  if (startToken) {
    startParams.set("start_token", startToken);
  } else {
    startParams.set("nonce", nonce);
    startParams.set("oauth_redirect", redirectUrl);
    startParams.set("redirect_uri", redirectUri);
    startParams.set("flow", flow);
    startParams.set("client_id", clientId);

    if (policyId) {
      startParams.set("policy_id", policyId);
    }
  }

  const normalizedBaseUrl = isolatedHostUrl.endsWith("/")
    ? isolatedHostUrl.slice(0, -1)
    : isolatedHostUrl;

  return `${normalizedBaseUrl}/start?${startParams.toString()}`;
};

export const parseOAuthCallbackUrl = (url: string | URL): PersistedSwigSession => {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const params = getCallbackParams(parsedUrl);

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

  const parsedRoleId = Number(roleId);
  if (!Number.isFinite(parsedRoleId)) {
    throw new Error("Invalid callback param: role_id must be a number");
  }

  return {
    configAddress,
    walletAddress,
    roleId: parsedRoleId,
    authFlow: "role",
    updatedAt: Date.now(),
  };
};

const getCallbackParams = (url: URL): URLSearchParams => {
  if (url.searchParams.size > 0) {
    return url.searchParams;
  }

  if (!url.hash) {
    return url.searchParams;
  }

  const hash = url.hash.slice(1);
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash;
  return new URLSearchParams(hashQuery);
};
