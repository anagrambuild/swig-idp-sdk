# @swig-wallet/expo-idp-sdk

Minimal Expo-compatible Swig IdP SDK scaffold.

## Public API (v1)

- `SwigIdpProvider`
- `useSwigIdp()`
- public types from `provider.tsx`

## Package structure

```txt
src/
  hooks/
    use-swig-idp.ts
  proof/
    proof-pipeline.ts
  states/
    states.ts
    bootstrap.ts
    begin-auth.ts
    complete-auth.ts
  swig-session/
    session-service.ts
    session-store.ts
  transport/
    api.ts
  index.ts
  provider.tsx
```

## Usage

```tsx
import { SwigIdpProvider, useSwigIdp } from "@swig-wallet/expo-idp-sdk";

function LoginButton() {
  const { beginAuth, completeAuth, isAuthenticated, authPhase } = useSwigIdp();

  if (isAuthenticated) {
    return null;
  }

  return (
    <button
      onClick={async () => {
        const { redirect_url } = await beginAuth({
          provider: "google",
          client_id: "your-client-id",
          redirect_uri: "yourapp://callback",
          state: "nonce-state",
        });

        // TODO: perform provider redirect + callback handling using redirect_url.
        // TODO: generate zk_proof from callback artifacts before calling completeAuth.
        await completeAuth({
          client_id: "your-client-id",
          network: "devnet",
          zk_proof: "todo-zk-proof",
        });
      }}
    >
      {authPhase === "begin_session_exchange" ? "Finalizing..." : "Continue"}
    </button>
  );
}

export function App() {
  return (
    <SwigIdpProvider
      config={{
        baseUrl: "https://api.example.com/backend",
        redirectUri: "yourapp://auth/callback",
      }}
    >
      <LoginButton />
    </SwigIdpProvider>
  );
}
```

## Notes

- `proof/*`, `swig-session/*`, `states/*`, and `transport/*` are internal modules and not part of the stable SDK contract.
- Session persistence defaults to `expo-secure-store`. Pass a custom `storage` adapter in config to override.
- `isolatedHostUrl` is optional and defaults to `https://swig-dev-portal-isolated-host.vercel.app`.
- Install `expo-secure-store` in the host Expo/React Native app.
- High-level public flow is `beginAuth()` then `completeAuth()`.
- `transport/api.ts` is a thin 1:1 wrapper over `api_idp.proto` and `api_wallet.proto` HTTP mappings.
- Business logic remains scaffolded with TODOs in:
  - `proof/proof-pipeline.ts`
  - `swig-session/session-service.ts`
  - `states/complete-auth.ts`
- No webview / isolated-host module is used in this scaffold.
- `completeAuth()` accepts either:
  - signup shape (`client_id`, `network`, `zk_proof`) or
  - session shape (`client_id`, `network`, `zk_proof`, `swig_pubkey`, `session_key`, `duration`)
- Auth phases:
  - `start`
  - `begin_oauth`
  - `complete_oauth`
  - `begin_swig_jwt`
  - `end_swig_jwt`
  - `begin_proof`
  - `end_proof`
  - `begin_session_exchange`
  - `swig_program_session_started`
  - `authenticated`
  - `error`
- TODO areas:
  - proof generation
  - session exchange
  - session lifecycle policy
- Default endpoint mapping:
  - `listProviders` -> `/identity/api/providers`
  - `startAuth` -> `/identity/api/auth/start`
  - `signup` -> `/identity/api/signup`
  - `createSession` -> `/identity/api/session`
  - `lookupSwig` -> `/wallet/swig/lookup`
  - `getSwigStatus` -> `/wallet/swig/status`
  - `checkSwigAuth` -> `/wallet/swig/auth/check`
  - `createSwigSession` -> `/wallet/swig/session`
  - `getPolicy` -> `/wallet/policies/{policy_id}`
