/* In-browser stand-in for the subset of Playwright's Page API that
 * tests/native-fixture.ts uses (route / routeWebSocket), so the exact same
 * fixture handlers and payloads can drive the real app for Designer review.
 * Only loaded by fixture/index.html on a loopback dev server; never bundled. */
type Fulfill = { json?: unknown; status?: number; body?: string; contentType?: string; headers?: Record<string, string> };
type RouteHandler = (route: FakeRoute) => unknown;
type WsHandler = (socket: FakeSocketRoute) => unknown;

function globToRegExp(glob: string) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; }
    else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
const matches = (pattern: string | RegExp, url: string) =>
  typeof pattern === "string" ? globToRegExp(pattern).test(url) : pattern.test(url);

class FakeRoute {
  constructor(
    private readonly req: { url: string; method: string; body: string | null; bytes: Uint8Array | null; headers: Record<string, string> },
    private readonly resolve: (response: Response) => void,
  ) {}
  request() {
    const r = this.req;
    return {
      url: () => r.url,
      method: () => r.method,
      postData: () => r.body,
      postDataJSON: () => (r.body ? JSON.parse(r.body) : null),
      postDataBuffer: () => r.bytes,
      headers: () => r.headers,
    };
  }
  async fulfill(f: Fulfill) {
    const body = f.json !== undefined ? JSON.stringify(f.json) : (f.body ?? "");
    const type = f.contentType ?? (f.json !== undefined ? "application/json" : "text/plain");
    this.resolve(new Response(body, { status: f.status ?? 200, headers: { "content-type": type, ...(f.headers ?? {}) } }));
  }
}

const RealWebSocket = window.WebSocket;
class FakeSocketRoute {
  private listeners: ((raw: string) => void)[] = [];
  constructor(private readonly client: FakeWebSocket) {}
  url() { return this.client.url; }
  onMessage(cb: (raw: string) => void) { this.listeners.push(cb); }
  onClose() {}
  send(raw: string) { this.client._receive(raw); }
  close(options: { code?: number; reason?: string } = {}) { this.client._closed(options.code ?? 1000, options.reason ?? ""); }
  _deliver(raw: string) { for (const cb of this.listeners) cb(raw); }
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
  readyState = 0; binaryType: BinaryType = "blob"; protocol = ""; extensions = ""; bufferedAmount = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private route: FakeSocketRoute;
  constructor(public readonly url: string, handler: WsHandler) {
    super();
    this.route = new FakeSocketRoute(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", new Event("open"));
      void handler(this.route);
    }, 0);
  }
  private fire(type: string, event: Event) {
    const prop = (this as unknown as Record<string, unknown>)["on" + type];
    if (typeof prop === "function") (prop as (e: Event) => void).call(this, event);
    this.dispatchEvent(event);
  }
  send(raw: string) {
    if (this.readyState !== 1) return;
    setTimeout(() => this.route._deliver(String(raw)), 0);
  }
  close(code = 1000, reason = "") { this._closed(code, reason); }
  _receive(raw: string) {
    if (this.readyState !== 1) return;
    setTimeout(() => this.fire("message", new MessageEvent("message", { data: raw })), 0);
  }
  _closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.fire("close", new CloseEvent("close", { code, reason, wasClean: true })), 0);
  }
}

export function installPageShim() {
  const routes: { pattern: string | RegExp; handler: RouteHandler }[] = [];
  const sockets: { pattern: string | RegExp; handler: WsHandler }[] = [];
  const websocketObservers: ((socket: { url(): string }) => void)[] = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url, location.href).href;
    // Playwright semantics: the most recently registered matching route wins.
    const hit = [...routes].reverse().find((r) => matches(r.pattern, url));
    if (!hit) return realFetch(input, init);
    const buffer = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.clone().arrayBuffer());
    const body = buffer && buffer.length ? new TextDecoder().decode(buffer) : null;
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    return new Promise<Response>((resolve) => {
      void hit.handler(new FakeRoute({ url, method: request.method, body, bytes: buffer, headers }, resolve));
    });
  };
  const Shim = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const href = new URL(String(url), location.href).href;
    const hit = [...sockets].reverse().find((s) => matches(s.pattern, href));
    const socket = hit ? new FakeWebSocket(href, hit.handler) : new RealWebSocket(url, protocols);
    // The shared backend observes socket URLs to prove native Host transport
    // stays on Server. Observing a socket never installs a second carrier.
    for (const observer of websocketObservers) observer({ url: () => href });
    return socket;
  } as unknown as typeof WebSocket;
  Object.assign(Shim, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Shim;
  return {
    on: (event: "websocket", observer: (socket: { url(): string }) => void) => {
      if (event === "websocket") websocketObservers.push(observer);
    },
    // The fixture mounts the app in this document after staging; run bootstrap
    // preferences now, before AppStore starts, rather than scheduling navigation.
    addInitScript: async <T>(script: (argument: T) => unknown, argument: T) => {
      script(argument);
    },
    route: async (pattern: string | RegExp, handler: RouteHandler) => { routes.push({ pattern, handler }); },
    routeWebSocket: async (pattern: string | RegExp, handler: WsHandler) => { sockets.push({ pattern, handler }); },
  };
}
