import { createContext } from "react";

/** A document editor can veto shell dismissal while its draft is dirty or saving. */
export const ContentCloseGuardContext = createContext<
  ((guard: (proceed?: () => void) => boolean) => () => void) | null
>(null);
