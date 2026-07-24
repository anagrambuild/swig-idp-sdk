import * as SecureStore from "expo-secure-store";

export const DEFAULT_STORAGE_KEY = "swig.idp.session";

type SessionStorageAdapterLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type PersistedSwigSession = {
  configAddress: string;
  walletAddress: string;
  roleId: number;
  authFlow: "session" | "role";
  updatedAt: number;
  expiresAt?: number;
  authorityPublicKey?: string;
  requesterAuthority?: SwigRequesterAuthority;
};

export type SwigRequesterAuthority =
  | { ed25519: { publicKey: string } }
  | { secp256k1: { publicKey: string } }
  | { secp256r1: { publicKey: string } }
  | { programExecProof: { roleId: number; zkProof: string } };

class ExpoSecureStoreAdapter implements SessionStorageAdapterLike {
  async getItem(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  }

  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  }
}

let secureStorage: SessionStorageAdapterLike | null = null;

const resolveStorage = (storage?: SessionStorageAdapterLike): SessionStorageAdapterLike => {
  if (storage) {
    return storage;
  }

  if (!secureStorage) {
    secureStorage = new ExpoSecureStoreAdapter();
  }

  return secureStorage;
};

export class SwigSessionStore {
  constructor(
    private readonly storage: SessionStorageAdapterLike,
    private readonly storageKey: string,
  ) {}

  async load(): Promise<PersistedSwigSession | null> {
    const raw = await this.storage.getItem(this.storageKey);

    if (!raw) {
      return null;
    }

    try {
      const session = JSON.parse(raw) as PersistedSwigSession;
      if (!session.configAddress || !session.walletAddress || session.roleId == null) {
        await this.clear();
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  async save(session: PersistedSwigSession): Promise<void> {
    await this.storage.setItem(this.storageKey, JSON.stringify(session));
  }

  async hasActiveSession(): Promise<boolean> {
    const session = await this.load();
    return session !== null;
  }

  async clear(): Promise<void> {
    await this.storage.removeItem(this.storageKey);
  }
}

export const resolveSwigSessionStore = (
  storage?: SessionStorageAdapterLike,
  storageKey: string = DEFAULT_STORAGE_KEY,
): SwigSessionStore => {
  return new SwigSessionStore(resolveStorage(storage), storageKey);
};
