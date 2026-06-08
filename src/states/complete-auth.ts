import type { ProofPipeline } from "../proof/proof-pipeline.js";
import type {
  PersistableAuthResult,
  SwigSessionService,
} from "../swig-session/session-service.js";
import type { SwigApiClient } from "../transport/api.js";
import type { NetworkValue } from "../utils.js";
import type { AuthDispatch } from "./states.js";

export type CompleteAuthInput = {
  client_id: string;
  network: NetworkValue;
  zk_proof?: string;
  proof_payload?: Record<string, unknown>;
};

export type CompleteAuthOutput = PersistableAuthResult;

type ResolveSwigJwtArtifactInput = {
  client_id: string;
  network: NetworkValue;
  proof_payload?: Record<string, unknown>;
};

type ResolveSwigJwtArtifact = (input: ResolveSwigJwtArtifactInput) => Promise<void>;

const defaultResolveSwigJwtArtifact: ResolveSwigJwtArtifact = async ({
  client_id: _clientId,
  network: _network,
  proof_payload: _proofPayload,
}): Promise<void> => {
  // TODO(SWI-289):
  // Implement explicit Swig JWT exchange/refresh stage here and feed artifact
  // into proof generation inputs.
};

// Business logic for completeAuth belongs in this file.
export const runCompleteAuthFlow = async ({
  input,
  api,
  proofPipeline,
  sessionService,
  dispatch,
  resolveSwigJwtArtifact = defaultResolveSwigJwtArtifact,
}: {
  input: CompleteAuthInput;
  api: SwigApiClient;
  proofPipeline: ProofPipeline;
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
  resolveSwigJwtArtifact?: ResolveSwigJwtArtifact;
}): Promise<CompleteAuthOutput> => {
  dispatch({ type: "COMPLETE_OAUTH" });

  try {
    dispatch({ type: "BEGIN_SWIG_JWT" });
    await resolveSwigJwtArtifact({
      client_id: input.client_id,
      network: input.network,
      ...(input.proof_payload ? { proof_payload: input.proof_payload } : {}),
    });
    dispatch({ type: "END_SWIG_JWT" });

    dispatch({ type: "BEGIN_PROOF" });
    const zkProof = await proofPipeline.resolveZkProof({
      client_id: input.client_id,
      network: input.network,
      ...(input.zk_proof ? { zk_proof: input.zk_proof } : {}),
      ...(input.proof_payload ? { proof_payload: input.proof_payload } : {}),
    });
    dispatch({ type: "END_PROOF" });

    dispatch({ type: "BEGIN_SESSION_EXCHANGE" });
    const result = await completeWithSignupPath(api, {
      client_id: input.client_id,
      network: input.network,
      zk_proof: zkProof,
    });

    dispatch({ type: "SWIG_PROGRAM_SESSION_STARTED" });
    await sessionService.persistFromCompleteAuth(result);
    dispatch({ type: "AUTHENTICATED" });

    return result;
  } catch (error) {
    dispatch({
      type: "ERROR",
      message: error instanceof Error ? error.message : "completeAuth failed",
    });
    throw error;
  }
};

const completeWithSignupPath = async (
  api: SwigApiClient,
  input: Pick<CompleteAuthInput, "client_id" | "network"> & { zk_proof: string },
): Promise<CompleteAuthOutput> => {
  const response = await api.signup({
    client_id: input.client_id,
    network: input.network,
    zk_proof: input.zk_proof,
  });

  return {
    flow: "signup",
    status: response.status,
    signature: response.signature,
    swig_pubkey: response.swig_pubkey,
    wallet_address: response.wallet_address,
  };
};
