import type { PersistedSwigSession, SwigSessionStore } from "./session-store";

export type PersistableAuthResult = {
  flow: "signup" | "session";
  status: string;
  signature: string;
  swig_pubkey?: string;
  wallet_address?: string;
  role_id?: number;
};

export class SwigSessionService {
  constructor(private readonly store: SwigSessionStore) {}

  hasActiveSession(): Promise<boolean> {
    return this.store.hasActiveSession();
  }

  async persistFromCompleteAuth(result: PersistableAuthResult): Promise<void> {
    // TODO(SWI-289):
    // Replace with authoritative session material once backend session exchange
    // and refresh/revocation contracts are finalized.
  
  }

  save(session: PersistedSwigSession): Promise<void> {
    return this.store.save(session);
  }

  load(): Promise<PersistedSwigSession | null> {
    return this.store.load();
  }

  clear(): Promise<void> {
    return this.store.clear();
  }
}
