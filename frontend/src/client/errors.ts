import { diagnosticText } from "./diagnostics";
/** A correlated command failure. `outcomeUnknown` means a mutation may have
 * landed and must be observed, never replayed. */
export class CommandError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public outcomeUnknown = false,
    public details?: Record<string, unknown>,
  ) {
    super(diagnosticText(message));
    this.code = diagnosticText(code, 128);
    // Command receipts also carry non-diagnostic ownership/reconciliation facts.
    // Project a safe copy only at display/console boundaries.
  }
}
