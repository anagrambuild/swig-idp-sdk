import type { SwigApiClient, StartAuthRequest, StartAuthResponse } from "../transport/api";
import type { AuthDispatch } from "./states";

export type BeginAuthInput = StartAuthRequest;

export type BeginAuthOutput = StartAuthResponse;

// Business logic for beginAuth belongs in this file.
export const runBeginAuthFlow = async ({
  input,
  api,
  dispatch,
}: {
  input: BeginAuthInput;
  api: SwigApiClient;
  dispatch: AuthDispatch;
}): Promise<BeginAuthOutput> => {
  dispatch({ type: "BEGIN_OAUTH" });

  try {
    return await api.startAuth(input);
  } catch (error) {
    dispatch({
      type: "ERROR",
      message: error instanceof Error ? error.message : "beginAuth failed",
    });
    throw error;
  }
};
