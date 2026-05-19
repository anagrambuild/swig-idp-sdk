import type { PersistedSwigSession } from "../swig-session/session-store.js";
import { Network, type NetworkValue } from "../utils.js";

export type AgentRevokeCallbackResult = {
  configAddress: string;
  walletAddress: string;
  roleId: number;
  signature: string | null;
  authorityPublicKey: string | null;
  network: NetworkValue | null;
  status: "revoked";
};

export type BuildIsolatedHostStartUrlInput = {
  isolatedHostUrl: string;
  redirectUri: string;
  redirectUrl: string;
  nonce: string;
  flow: "role" | "session";
  clientId: string;
  startToken?: string;
  policyId?: string;
  authorityPublicKey?: string;
  roleIntent?: "agent";
  agentName?: string;
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
  authorityPublicKey,
  roleIntent,
  agentName,
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
    if (authorityPublicKey) {
      startParams.set("authority_public_key", authorityPublicKey);
    }
    if (roleIntent) {
      startParams.set("role_intent", roleIntent);
    }
    if (agentName) {
      startParams.set("agent_name", agentName);
    }
  }

  const normalizedBaseUrl = isolatedHostUrl.endsWith("/")
    ? isolatedHostUrl.slice(0, -1)
    : isolatedHostUrl;

  return `${normalizedBaseUrl}/redirect?${startParams.toString()}`;
};

export const parseOAuthCallbackUrl = (url: string | URL): PersistedSwigSession => {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const params = getCallbackParams(parsedUrl);

  const error = params.get("error");
  if (error) {
    throw new Error(params.get("error_description") ?? error);
  }

  if (params.get("role_operation") === "revoke") {
    throw new Error("Use parseAgentRevokeCallbackUrl for agent revoke callbacks");
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

export const parseAgentRevokeCallbackUrl = (url: string | URL): AgentRevokeCallbackResult => {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const params = getCallbackParams(parsedUrl);

  const error = params.get("error");
  if (error) {
    throw new Error(params.get("error_description") ?? error);
  }

  if (params.get("role_operation") !== "revoke") {
    throw new Error("Callback is not an agent revoke result");
  }

  const configAddress = params.get("swig_pubkey");
  const walletAddress = params.get("wallet_address");
  const roleId = params.get("role_id");

  if (!configAddress || !walletAddress || !roleId) {
    throw new Error("Missing required revoke callback params");
  }

  const parsedRoleId = Number(roleId);
  if (!Number.isFinite(parsedRoleId) || parsedRoleId <= 0) {
    throw new Error("Invalid callback param: role_id must be a positive number");
  }

  return {
    configAddress,
    walletAddress,
    roleId: parsedRoleId,
    signature: params.get("signature"),
    authorityPublicKey: params.get("authority_public_key"),
    network: parseNetworkParam(params.get("network")),
    status: "revoked",
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

const parseNetworkParam = (value: string | null): NetworkValue | null => {
  if (!value) {
    return null;
  }

  const network = Number(value);
  if (network === Network.Devnet || network === Network.Mainnet) {
    return network as NetworkValue;
  }

  throw new Error("Invalid callback param: network must be devnet or mainnet");
};
