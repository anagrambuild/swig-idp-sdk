import { useContext } from "react";

import { SwigIdpContext, type SwigIdpContextValue } from "../provider";

export const useSwigIdp = (): SwigIdpContextValue => {
  const context = useContext(SwigIdpContext);

  if (!context) {
    throw new Error("useSwigIdp must be used within a SwigIdpProvider");
  }

  return context;
};
