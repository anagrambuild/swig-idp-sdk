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
  const { startOAuth, isAuthenticated, authPhase } = useSwigIdp();

  if (isAuthenticated) {
    return null;
  }

  return (
    <button
      onClick={async () => {
        await startOAuth({
          provider: "google",
          clientId: "your-client-id",
          policyId: "your-policy-id",
          flow: "role",
        });
      }}
    >
      {authPhase === "begin_oauth" ? "Opening browser..." : "Continue"}
    </button>
  );
}

export function App() {
  return (
    <SwigIdpProvider
      config={{
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
- `baseUrl` is optional and defaults to `https://backend.prod.infra.onswig.com`.
- `isolatedHostUrl` is optional and defaults to `https://swig-dev-portal-isolated-host.vercel.app`.
- Install `expo-secure-store` in the host Expo/React Native app.
- High-level public flow is `startOAuth()`.
- `transport/api.ts` is a thin 1:1 wrapper over `api_idp.proto` and `api_wallet.proto` HTTP mappings.
- OAuth start now prefers a backend-issued `start_token` for the isolated host redirect, and falls back to the legacy raw redirect params only when the backend has not been upgraded yet.
- Mobile auth is intentionally routed through `expo-web-browser` system auth sessions via `openAuthSessionAsync`.
- Embedded `WebView` auth is unsupported. Do not load the isolated host inside `react-native-webview` or any host-controlled in-app browser if you need production security guarantees.
- Business logic remains scaffolded with TODOs in:
  - `proof/proof-pipeline.ts`
  - `swig-session/session-service.ts`
  - `states/complete-auth.ts`
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

## Security boundary

- The SDK's supported mobile auth path is `startOAuth()`, which opens the isolated host in a system auth session.
- Do not embed the isolated host in a `WebView`. A host app that owns the `WebView` can inspect DOM, URLs, and storage.
- If you need a custom mobile integration, preserve the same boundary: backend start token -> isolated host -> system auth session -> deep link callback.

## License

Apache-2.0
