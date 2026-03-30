export type SwigAuthPhase =
  | "start"
  | "begin_oauth"
  | "complete_oauth"
  | "begin_swig_jwt"
  | "end_swig_jwt"
  | "begin_proof"
  | "end_proof"
  | "begin_session_exchange"
  | "swig_program_session_started"
  | "authenticated"
  | "error";

export type AuthMachineState = {
  phase: SwigAuthPhase;
  isReady: boolean;
  isAuthenticated: boolean;
  lastError: string | null;
};

export type AuthMachineAction =
  | { type: "BOOTSTRAP_DONE"; isAuthenticated: boolean }
  | { type: "BEGIN_OAUTH" }
  | { type: "COMPLETE_OAUTH" }
  | { type: "BEGIN_SWIG_JWT" }
  | { type: "END_SWIG_JWT" }
  | { type: "BEGIN_PROOF" }
  | { type: "END_PROOF" }
  | { type: "BEGIN_SESSION_EXCHANGE" }
  | { type: "SWIG_PROGRAM_SESSION_STARTED" }
  | { type: "AUTHENTICATED" }
  | { type: "LOGOUT_DONE" }
  | { type: "ERROR"; message: string };

export type AuthDispatch = (action: AuthMachineAction) => void;

export const initialAuthMachineState: AuthMachineState = {
  phase: "start",
  isReady: false,
  isAuthenticated: false,
  lastError: null,
};

export const authMachineReducer = (
  state: AuthMachineState,
  action: AuthMachineAction,
): AuthMachineState => {
  switch (action.type) {
    case "BOOTSTRAP_DONE": {
      return {
        phase: action.isAuthenticated ? "authenticated" : "start",
        isReady: true,
        isAuthenticated: action.isAuthenticated,
        lastError: null,
      };
    }

    case "BEGIN_OAUTH": {
      return {
        ...state,
        phase: "begin_oauth",
        lastError: null,
      };
    }

    case "COMPLETE_OAUTH": {
      return {
        ...state,
        phase: "complete_oauth",
        lastError: null,
      };
    }

    case "BEGIN_SWIG_JWT": {
      return {
        ...state,
        phase: "begin_swig_jwt",
        lastError: null,
      };
    }

    case "END_SWIG_JWT": {
      return {
        ...state,
        phase: "end_swig_jwt",
        lastError: null,
      };
    }

    case "BEGIN_PROOF": {
      return {
        ...state,
        phase: "begin_proof",
        lastError: null,
      };
    }

    case "END_PROOF": {
      return {
        ...state,
        phase: "end_proof",
        lastError: null,
      };
    }

    case "BEGIN_SESSION_EXCHANGE": {
      return {
        ...state,
        phase: "begin_session_exchange",
        lastError: null,
      };
    }

    case "SWIG_PROGRAM_SESSION_STARTED": {
      return {
        ...state,
        phase: "swig_program_session_started",
        lastError: null,
      };
    }

    case "AUTHENTICATED": {
      return {
        ...state,
        phase: "authenticated",
        isAuthenticated: true,
        lastError: null,
      };
    }

    case "LOGOUT_DONE": {
      return {
        ...state,
        phase: "start",
        isAuthenticated: false,
        lastError: null,
      };
    }

    case "ERROR": {
      return {
        ...state,
        phase: "error",
        lastError: action.message,
      };
    }

    default: {
      return state;
    }
  }
};
