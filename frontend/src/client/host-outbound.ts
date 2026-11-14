import { CommandError } from "./errors";

export interface OutboundOffer {
  attempt_id: string;
  capability: string;
  url: string;
  expires_in_ms: number;
}

/** Only the already trusted loopback bridge can bootstrap a server-owned route.
 * This socket carries a short-lived offer, never the Host data stream. */
export function outboundSignalUrl(locator: string): string | null {
  try {
    const url = new URL(locator);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/host"
    )
      return null;
    url.pathname = "/host/signal";
    return url.href;
  } catch {
    return null;
  }
}

/** Resolve once the Bridge acknowledges ownership of the offer. Closing this
 * observation must not terminate its outbound connection or an admitted route. */
export function signalOutbound(
  locator: string,
  offer: OutboundOffer,
  current: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = new WebSocket(locator);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () =>
        finish(
          new CommandError(
            "host_outbound_unavailable",
            "Local Host outbound signaling timed out",
            true,
          ),
        ),
      Math.min(offer.expires_in_ms, 10000),
    );
    signal.onopen = () => {
      if (!current()) {
        finish(
          new CommandError(
            "disconnected",
            "Host connection observation was replaced",
          ),
        );
        return;
      }
      signal.send(JSON.stringify(offer));
    };
    signal.onmessage = ({ data }) => {
      if (!current()) {
        finish(
          new CommandError(
            "disconnected",
            "Host connection observation was replaced",
          ),
        );
        return;
      }
      if (typeof data !== "string" || data.length > 4096) {
        finish(
          new CommandError(
            "host_outbound_unavailable",
            "Invalid Host signaling response",
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(data);
        if (result.status === "connecting" || result.status === "connected")
          finish();
        else if (result.status === "failed")
          finish(
            new CommandError(
              result.phase === "auth_unknown"
                ? "host_pairing_outcome_unknown"
                : "host_outbound_unavailable",
              "Local Host outbound connection could not be established",
            ),
          );
        else
          finish(
            new CommandError(
              "host_outbound_unavailable",
              "Invalid Host signaling status",
            ),
          );
      } catch {
        finish(
          new CommandError(
            "host_outbound_unavailable",
            "Invalid Host signaling response",
          ),
        );
      }
    };
    signal.onerror = () => {
      /* The close event owns the concrete failure. */
    };
    signal.onclose = () =>
      finish(
        new CommandError(
          "host_outbound_unavailable",
          "Local Host outbound signaling closed before acknowledgement",
          true,
        ),
      );
  });
}
