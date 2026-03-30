export type ResolveProofInput = {
  client_id: string;
  network: string;
  zk_proof?: string;
  proof_payload?: Record<string, unknown>;
};

export type ProofPipeline = {
  resolveZkProof(input: ResolveProofInput): Promise<string>;
};

class DefaultProofPipeline implements ProofPipeline {
  async resolveZkProof(input: ResolveProofInput): Promise<string> {
    if (input.zk_proof) {
      return input.zk_proof;
    }

    // TODO(SWI-289):
    // Generate proof from callback artifacts/token claims and proving keys.
    // Keep proof generation client-side.
    throw new Error("Missing zk_proof. Configure proof pipeline to generate one.");
  }
}

export const createProofPipeline = (override?: Partial<ProofPipeline>): ProofPipeline => {
  const base = new DefaultProofPipeline();

  if (!override?.resolveZkProof) {
    return base;
  }

  return {
    resolveZkProof: override.resolveZkProof,
  };
};
