import {
  diagnosticDetails,
  diagnosticMessage,
  diagnosticText,
  reportDiagnostic,
} from "./diagnostics";

type Failure = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};
/** Per-socket observation only. Never retries a request or stores payload/error references.
 * A brief successful handshake does not erase a continuing reconnect failure streak. */
export class TransportDiagnosticStreak {
  private first: Failure | null = null;
  private key: string | null = null;
  private suppressed = 0;
  private lastReport = 0;
  private stable: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly source: string) {}

  failure(method: string, error: unknown): void {
    clearTimeout(this.stable);
    this.stable = undefined;
    const raw =
      error && typeof error === "object"
        ? (error as Record<string, unknown>)
        : {};
    const failure: Failure = {
      code: diagnosticText(raw.code, 128) || "disconnected",
      message: diagnosticMessage(error),
      details: diagnosticDetails(raw.details),
    };
    const key = JSON.stringify([
      method,
      failure.code,
      failure.details.close_code,
    ]);
    const now = Date.now();
    if (!this.first || this.key !== key) {
      this.first = failure;
      this.key = key;
      this.suppressed = 0;
      this.lastReport = now;
      reportDiagnostic(this.source, method, failure, undefined, "warn");
      return;
    }
    this.suppressed++;
    if (now - this.lastReport >= 60000) {
      this.lastReport = now;
      reportDiagnostic(
        this.source,
        method,
        {
          ...this.first,
          details: { ...this.first.details, suppressed_count: this.suppressed },
        },
        undefined,
        "warn",
      );
    }
  }

  connected(): void {
    clearTimeout(this.stable);
    if (this.first) this.stable = setTimeout(() => this.recovered(), 5000);
  }

  recovered(): void {
    clearTimeout(this.stable);
    this.stable = undefined;
    const first = this.first;
    if (!first) return;
    this.first = null;
    this.key = null;
    const suppressed = this.suppressed;
    this.suppressed = 0;
    reportDiagnostic(
      this.source,
      "reconnected",
      {
        code: "reconnected",
        message: "WebSocket connection recovered",
        details: {
          ...first.details,
          cause: first.message,
          suppressed_count: suppressed,
        },
      },
      undefined,
      "info",
    );
  }
}
