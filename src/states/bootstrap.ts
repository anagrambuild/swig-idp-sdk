import type { SwigSessionService } from "../swig-session/session-service";
import type { AuthDispatch } from "./states";

// Business logic for startup auth hydration belongs in this file.
export const bootstrapAuthState = async ({
  sessionService,
  dispatch,
}: {
  sessionService: SwigSessionService;
  dispatch: AuthDispatch;
}): Promise<void> => {
  const isAuthenticated = await sessionService.hasActiveSession();

  dispatch({
    type: "BOOTSTRAP_DONE",
    isAuthenticated,
  });
};
