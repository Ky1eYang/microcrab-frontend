import type { Page, WebSocketRoute } from "@playwright/test";
import type {
  NativeSnapshot,
  NativeChildDetail,
  PermissionRequest,
  RoundLimitRequest,
} from "../src/client/types";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";
import { LIMIT_FIELDS } from "../src/client/settings";
export const nativeSnapshot: NativeSnapshot = {
  session: {
    id: "s1",
    title: "原生会话",
    project_id: "project-1",
    status: "idle",
    agent: "coding",
    mode: "plan",
    model: "model-1",
    created_at_ms: 1,
    updated_at_ms: 2,
    revision: 1,
    archived: false,
  },
  messages: [
    { id: "m1", role: "user", text: "历史提问", parts: [], tool_calls: [] },
    {
      id: "m2",
      role: "assistant",
      text: "历史回答",
      parts: [],
      tool_calls: [],
    },
  ],
  permission: {
    revision: 3,
    config: { overrides: [], review: true, initialization: "ask" },
  },
  operations: [],
  executions: [],
  executions_omitted: false,
  history: null,
  usage: null,
};
/** Keys delivered by blocks.* events rather than session.meta. */
const CANONICAL = [
  "messages",
  "messages_truncated",
  "next_cursor",
  "history_view",
];
/** Keys sent once after attach and then by their own events. */
const DEFERRED = ["statistics", "state", "usage"];
/** Attach metadata: the view without rows and deferred bulk fields. */
export function attachMeta(view: NativeSnapshot): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ...view,
    executions: view.executions ?? [],
    executions_omitted: view.executions_omitted ?? false,
  };
  for (const key of [
    "messages",
    "messages_truncated",
    "next_cursor",
    ...DEFERRED,
  ])
    delete meta[key];
  return meta;
}
function blocksWindow(view: NativeSnapshot) {
  return {
    messages_truncated: view.messages_truncated,
    next_cursor: view.next_cursor,
    history_view: view.history_view,
  };
}
/**
 * The server's incremental publication (manager/hub/publication.rs): the
 * ordered events that move a client holding `previous` to `next`.
 */
export function publication(
  previous: NativeSnapshot,
  next: NativeSnapshot,
): [string, unknown][] {
  const events: [string, unknown][] = [];
  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (CANONICAL.includes(key) || key === "statistics") continue;
    const before = (previous as any)[key] ?? null;
    const after = (next as any)[key] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after)) patch[key] = after;
  }
  if (Object.keys(patch).length) events.push(["session.meta", patch]);
  const before = previous.messages ?? [];
  const after = next.messages ?? [];
  const lineageChanged =
    !!previous.history_view?.lineage &&
    !!next.history_view?.lineage &&
    previous.history_view.lineage !== next.history_view.lineage;
  const present = new Set(after.map((message) => message.id));
  const start = before.findIndex((message) => message.id === after[0]?.id);
  // Only a row vanishing inside the overlapping window is a rewrite.
  const rewritten =
    (before.length > 0 && after.length === 0) ||
    (after.length > 0 &&
      start >= 0 &&
      before.slice(start).some((message) => !present.has(message.id)));
  if (lineageChanged || rewritten) {
    events.push([
      "history.reset",
      {
        lineage: next.history_view?.lineage ?? null,
        epoch: next.history_view?.epoch ?? null,
        reason: lineageChanged ? "lineage" : "rewritten",
      },
    ]);
    events.push([
      "blocks.page",
      { reason: "reset", messages: after, ...blocksWindow(next) },
    ]);
  } else {
    const known = new Map(before.map((message) => [message.id, message]));
    const changed = after.filter(
      (message) =>
        JSON.stringify(known.get(message.id)) !== JSON.stringify(message),
    );
    const orderChanged =
      before.length !== after.length ||
      after.some((message, index) => message.id !== before[index]?.id);
    const windowChanged = [
      "messages_truncated",
      "next_cursor",
      "history_view",
    ].some(
      (key) =>
        JSON.stringify((previous as any)[key] ?? null) !==
        JSON.stringify((next as any)[key] ?? null),
    );
    if (changed.length || orderChanged || windowChanged)
      events.push([
        "blocks.upsert",
        {
          ids: after.map((message) => message.id),
          messages: changed,
          ...blocksWindow(next),
        },
      ]);
  }
  if (
    next.statistics != null &&
    JSON.stringify(previous.statistics ?? null) !==
      JSON.stringify(next.statistics)
  )
    events.push(["statistics.updated", next.statistics]);
  return events;
}
/** Ordered canonical initialization announced by the subscribed envelope. */
export function attachEvents(view: NativeSnapshot): [string, unknown][] {
  const initial: [string, unknown][] = [
    [
      "blocks.page",
      { reason: "attach", messages: view.messages, ...blocksWindow(view) },
    ],
  ];
  const deferred: Record<string, unknown> = {};
  if (view.state != null) deferred.state = view.state;
  if (view.usage != null) deferred.usage = view.usage;
  if (Object.keys(deferred).length) initial.push(["session.meta", deferred]);
  if (view.statistics != null)
    initial.push(["statistics.updated", view.statistics]);
  return initial;
}
/** Send the subscription barrier followed by all canonical initialization events. */
export function sendSubscribed(
  socket: { send(message: string): void },
  view: NativeSnapshot,
  subscriptionId: string,
  generation: string,
  options: {
    sequence?: number;
    pending?: unknown;
    sessionId?: string;
    frame?: Record<string, unknown>;
    initial?: boolean;
  } = {},
) {
  const sequence = options.sequence ?? 0;
  const sessionId = options.sessionId ?? view.session.id;
  const initial = attachEvents(view);
  socket.send(
    JSON.stringify({
      v: 1,
      type: "subscribed",
      subscription_id: subscriptionId,
      generation,
      sequence,
      session_id: sessionId,
      meta: attachMeta(view),
      resume: { mode: "fresh" },
      pending: options.pending ?? { permissions: null, round_limits: null },
      initial_events: initial.length,
      ...options.frame,
    }),
  );
  if (options.initial !== false)
    initial.forEach(([event, data], index) =>
      socket.send(
        JSON.stringify({
          v: 1,
          type: "event",
          subscription_id: subscriptionId,
          generation,
          sequence: sequence + index + 1,
          session_id: sessionId,
          event,
          data,
        }),
      ),
    );
  return sequence + (options.initial === false ? 0 : initial.length);
}
export async function nativeBackend(
  page: Page,
  options: {
    /** Native suites explicitly select their fixture Project; default-browser suites opt out. */
    selectProject?: boolean;
    extraMethods?: string[];
    /** Remove advertised methods (capability-absent states). */
    withoutMethods?: string[];
    retryTurn?: (command: any) => unknown | Promise<unknown>;
    inboxTurn?: (command: any) => unknown | Promise<unknown>;
    /** Handles one Session-socket command before the fixture defaults. `data`
     * becomes the result payload; `error` fails the result. `undefined` falls
     * through. The hook may resolve later to hold the receipt. */
    sessionCommand?: (
      command: any,
      sessionId: string,
    ) =>
      | { data: unknown }
      | {
          error: {
            code: string;
            message: string;
            details?: Record<string, unknown>;
          };
        }
      | undefined
      | Promise<
          | { data: unknown }
          | {
              error: {
                code: string;
                message: string;
                details?: Record<string, unknown>;
              };
            }
          | undefined
        >;
    submitError?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
    images?: boolean;
    holdCatalog?: boolean;
    holdLogout?: boolean;
    logoutRedirect?: string;
    suspendSessionOnAttach?: boolean;
    clientTools?: ClientBinding;
    projects?: {
      id: string;
      name: string;
      root: string;
      host_id?: string;
      workspace_id?: string;
    }[];
    owner?: string;
    reconciling?: boolean;
    catalogFailure?: boolean;
    rejectAddress?: boolean;
    children?: NativeChildDetail[];
    permissionRequests?: PermissionRequest[];
    holdPermissionReply?: boolean;
    roundLimitRequests?: RoundLimitRequest[];
    holdRoundLimitReply?: boolean;
    /** Further sessions listed beside s1; each attaches to its own view. */
    sessions?: NativeSnapshot[];
    /** Delay canonical subscription initialization to model a slow server. */
    attachDelayMs?: number;
  } = {},
) {
  let relayGeneration = 0;
  const commands: any[] = [],
    http: string[] = [],
    nativeUrls: string[] = [];
  const requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: any;
  }[] = [];
  const sockets: WebSocketRoute[] = [];
  const sessionSockets: WebSocketRoute[] = [];
  const bridges: string[] = [];
  /** Per-connection identity. Every session socket owns its own subscription,
   * generation and sequence; a later connection never rewrites an earlier
   * one, so events always carry the identity their socket was accepted with. */
  const connections = new Map<
    WebSocketRoute,
    {
      sessionId: string;
      subscription: string;
      generation: string;
      sequence: number;
      established: boolean;
      closed: boolean;
      published: NativeSnapshot | null;
    }
  >();
  /** The latest established, still-open socket for one Session. */
  const committedSocket = (sessionId: string) =>
    [...connections.entries()]
      .reverse()
      .find(
        ([, meta]) =>
          meta.sessionId === sessionId && meta.established && !meta.closed,
      );
  const emitOn = (
    socket: WebSocketRoute,
    event: string,
    data: unknown,
    offset = 1,
  ) => {
    const meta = connections.get(socket)!;
    meta.sequence += offset;
    socket.send(
      JSON.stringify({
        v: 1,
        type: "event",
        subscription_id: meta.subscription,
        generation: meta.generation,
        sequence: meta.sequence,
        session_id: meta.sessionId,
        event,
        data,
      }),
    );
  };
  let snapshot = structuredClone(nativeSnapshot);
  if (options.clientTools) snapshot.client_tools = options.clientTools;
  const projects = structuredClone(
    options.projects ?? [
      {
        id: "project-1",
        name: "Assigned",
        root: "/assigned",
        host_id: "h1",
        workspace_id: "w1",
      },
    ],
  );
  if (options.selectProject !== false && projects[0]) {
    await page.addInitScript(
      ({ projectId, owner }) => {
        const clientKey = "microcrab.browser-client.v1";
        const clientId = localStorage.getItem(clientKey) ?? crypto.randomUUID();
        localStorage.setItem(clientKey, clientId);
        const scope = JSON.stringify([`${location.origin}/`, owner, clientId]);
        const key = `microcrab.host-project.v2:${scope}`;
        if (localStorage.getItem(key) === null)
          localStorage.setItem(key, projectId);
      },
      { projectId: projects[0].id, owner: options.owner ?? "u1" },
    );
  }
  const directHosts = new Map<string, any>();
  const others = new Map(
    (options.sessions ?? []).map((view) => [view.session.id, view]),
  );
  let created = 0;
  const deletedSessions = new Set<string>();
  /** Owner-level list watch (`sessions.watch`) of the latest socket. */
  let listWatch: {
    socket: { send(message: string): void };
    id: string;
    generation: string;
    sequence: number;
  } | null = null;
  /** Publish one owner-level list event, as the server does after a write. */
  const listEvent = (event: string, data: any) => {
    if (!listWatch) return;
    listWatch.socket.send(
      JSON.stringify({
        v: 1,
        type: "event",
        subscription_id: listWatch.id,
        generation: listWatch.generation,
        sequence: ++listWatch.sequence,
        session_id: "",
        event,
        data,
      }),
    );
  };
  const listUpsert = (session: NativeSnapshot["session"]) =>
    setTimeout(() =>
      listEvent("sessions.changed", {
        op: "upsert",
        session: structuredClone(session),
      }),
    );
  let releasePermissionReply = () => {};
  /** Answers WebSocket session.blocks pages; a returned `error` fails the command. */
  let blocksHandler: (
    params: Record<string, unknown>,
    sessionId: string,
  ) => unknown | Promise<unknown> = () => ({
    items: [],
    truncated: false,
    next_cursor: null,
  });
  const permissionDecisions = new Map<string, string>();
  const pendingPermissions = options.permissionRequests ?? [];
  const pendingRoundLimits = options.roundLimitRequests ?? [];
  let releaseRoundLimitReply = () => {};
  let uploads = 0;
  const children = options.children ?? [];
  let releaseCatalog = () => {},
    releaseLogout = () => {};
  const methods = [
    "server.capabilities",
    "identity.current",
    "project.list",
    "project.create",
    "project.rename",
    "project.delete",
    "model.list",
    "agent.catalog",
    "session.list",
    "session.create",
    "session.open",
    "session.close",
    "display.subscribe",
    "sessions.watch",
    "host.relay_attach",
    "session.rename",
    "session.archive",
    "session.delete",
    "session.blocks",
    "session.compact",
    "turn.submit",
    "turn.queue",
    "turn.get",
    "session.interrupt",
    "session.set_mode",
    "session.set_model",
    "permission.get",
    "permission.set",
    "history.travel",
    "checkpoint.create",
    "executions.cancel",
    "workspace.files",
  ];
  methods.push(...(options.extraMethods ?? []));
  for (const m of options.withoutMethods ?? [])
    if (methods.includes(m)) methods.splice(methods.indexOf(m), 1);
  if (options.children) methods.push("session.children", "session.child");
  if (options.permissionRequests) methods.push("permission.reply");
  if (options.roundLimitRequests) methods.push("round_limit.reply");
  if (options.clientTools)
    methods.push(
      "client_tools.bind",
      "client_tools.result",
      "client_tools.prepare",
      "client_tools.unbind",
      "client_tools.arguments",
    );
  function attachNativeHost(
    id: string,
    action: string,
    body: any,
    reply: (value: any) => any,
    reject: (status: number, code: string, message: string) => any,
  ) {
    const project = projects.find((project) => project.id === id);
    if (!project)
      return reject(404, "project_unavailable", "Project is unavailable");
    if (action === "disconnect") {
      directHosts.delete(id);
      return reply({ detached: true });
    }
    if (body?.token === "expired")
      return reject(
        403,
        "pairing_expired",
        "Pairing token expired; request a new code from the Host",
      );
    const endpoint = body?.url ?? directHosts.get(id)?.url;
    if (!endpoint || (options.rejectAddress && endpoint.includes(":8788/")))
      return reject(502, "disconnected", "Host WebSocket connection refused");
    const host = endpoint.includes(":8789/") ? "h2" : "h1";
    const root = body?.directory ?? project.root ?? "/assigned";
    const known = projects.find(
      (candidate) => candidate.host_id === host && candidate.root === root,
    );
    const workspace =
      known?.workspace_id ??
      (root === "/assigned"
        ? "w1"
        : root === "/second"
          ? "w2"
          : `workspace:${root}`);
    if (
      (project.host_id && project.host_id !== host) ||
      (project.workspace_id && project.workspace_id !== workspace)
    )
      return reject(
        409,
        "binding_mismatch",
        "Direct Host identity differs from immutable Project pins",
      );
    const descriptor = {
      protocol_version: 2,
      host_id: host,
      workspace_id: workspace,
      bridge_instance_id: "b1",
      workspace_root: root,
      platform: "linux",
      info: {},
      tool_capabilities: ["read", "write"],
      supported_primitives: [],
      descriptor_digest: `digest:${host}:${root}`,
    };
    const existing = directHosts.get(id);
    const value = {
      descriptor,
      project_id: id,
      connection_generation: "1",
      connected: true,
      ready: !options.reconciling,
      reconciling: options.reconciling === true,
      reconciliation_error: options.reconciling
        ? {
            code: "host_reconciliation_required",
            message: "Old receipt pending",
          }
        : null,
    };
    directHosts.set(id, { ...value, url: endpoint });
    Object.assign(project, { host_id: host, workspace_id: workspace, root });
    const attached = committedSocket(snapshot.session.id);
    if (!existing && options.suspendSessionOnAttach && attached)
      emitOn(attached[0], "host_detached", { suspended: true });
    return reply(value);
  }
  const hostSockets: WebSocketRoute[] = [];
  const relayFrames: (string | Buffer)[] = [];
  await page.routeWebSocket(/\/host(?:$|\?)/, (socket) => {
    hostSockets.push(socket);
    bridges.push(socket.url());
    if (options.rejectAddress && socket.url().includes(":8788/")) {
      socket.close({ code: 1011, reason: "Host WebSocket connection refused" });
      return;
    }
    socket.onMessage((raw) => relayFrames.push(raw));
  });
  await page.route("**/api/**", (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const verb = request.method();
    const attachment =
      /\/sessions\/[^/]+\/attachments$/.test(path) && verb === "POST";
    const body = attachment
      ? {
          bytes: request.postDataBuffer()?.length ?? 0,
          mediaType: request.headers()["content-type"],
        }
      : request.postData()
        ? request.postDataJSON()
        : undefined;
    http.push(path);
    requests.push({
      method: verb,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
    });
    const reply = (json: unknown) => route.fulfill({ json });
    const reject = (status: number, code: string, message: string) =>
      route.fulfill({ status, json: { error: { code, message } } });
    if (attachment)
      return reply({
        attachment_id: `attachment-${++uploads}`,
        media_type: body.mediaType,
        bytes: body.bytes,
        width: 1,
        height: 1,
      });
    if (path === "/api/auth/session")
      return reply({
        authenticated: true,
        principal: {
          owner: options.owner ?? "u1",
          subject: "sub1",
          display_name: "Test User",
          expires_at: 9999999999,
        },
      });
    if (path === "/api/auth/logout" && verb === "POST") {
      if (options.holdLogout) {
        releaseLogout = () => {
          void reply({ ok: true });
        };
        return;
      }
      if (options.logoutRedirect)
        return reply({ redirect: options.logoutRedirect });
      return reply({ ok: true });
    }
    if (path === "/api/v1/health" && verb === "GET")
      return reply({ status: "ok" });
    if (path === "/api/v1/capabilities" && verb === "GET")
      return reply({
        protocol: 1,
        methods,
        features: options.images ? { image_data: true } : {},
        limits: options.images
          ? {
              command_bytes: 65536,
              attachment_image_bytes: 20 * 1024 * 1024,
              attachment_images: 20,
              attachment_message_bytes: 200 * 1024 * 1024,
              attachment_pixels: 64_000_000,
              attachment_max_side: 8192,
            }
          : {},
      });
    if (path === "/api/v1/identity" && verb === "GET")
      return reply({ owner: options.owner ?? "u1", subject: "sub1" });
    if (path === "/api/v1/projects" && verb === "GET")
      return reply({
        items: projects,
      });
    if (path === "/api/v1/projects" && verb === "POST") {
      const project = {
        id: `project-new-${++created}`,
        name: body.name,
        root: body.root,
      };
      projects.push(project);
      return reply(project);
    }
    if (/\/projects\/[^/]+\/provisional$/.test(path) && verb === "DELETE") {
      const id = path.split("/").at(-2)!;
      const index = projects.findIndex((p) => p.id === id);
      if (
        index < 0 ||
        projects[index].host_id ||
        id === snapshot.session.project_id
      )
        return reject(
          409,
          "not_provisional",
          "Project is not empty and unbound",
        );
      projects.splice(index, 1);
      return reply({ deleted: true });
    }
    const nativeHost =
      /^\/api\/v1\/projects\/([^/]+)\/host\/(connect|disconnect|refresh)$/.exec(
        path,
      );
    if (nativeHost && verb === "POST") {
      const [, id, action] = nativeHost;
      return attachNativeHost(id, action, body, reply, reject);
    }

    if (/\/projects\/[^/]+\/host-(state|reconcile)$/.test(path)) {
      const id = path.split("/").at(-2)!;
      return reply(
        directHosts.get(id) ?? {
          project_id: id,
          connected: false,
          ready: false,
        },
      );
    }
    if (/\/projects\/[^/]+\/operations$/.test(path))
      return reply({
        project_id: path.split("/").at(-2),
        connection_generation: "1",
        limit: 100,
        operations: [
          {
            operation_id: "old-unknown",
            payload_digest: "digest",
            state: "failed_unknown",
            reason: {
              code: "unknown_outcome",
              message: "Original outcome unavailable",
            },
            effects_may_have_occurred: true,
          },
        ],
      });
    if (
      (path === "/api/v1/settings" ||
        /^\/api\/v1\/projects\/[^/]+\/settings$/.test(path)) &&
      verb === "GET"
    ) {
      const limits = Object.fromEntries(
        LIMIT_FIELDS.map((field) => [field, 1048576]),
      );
      const effective = {
        limits,
        agent: "coding",
        mode: "plan",
        model_selection: {
          provider_id: "provider",
          model: "model-1",
          variant: null,
        },
      };
      return reply({
        revision: 0,
        overrides: {},
        effective,
        desired_effective: effective,
        sources: {},
        constraints: { limits },
        applied_revision: 0,
        application: "defaults_saved",
        reason: null,
      });
    }
    if (path === "/api/v1/models" && verb === "GET")
      return reply({
        items: [
          {
            id: "model-1",
            name: "Configured model",
            provider_id: "provider",
            variants: [],
          },
        ],
      });
    if (
      /\/(?:projects|conversations)\/[^/]+\/agents$/.test(path) &&
      verb === "GET"
    ) {
      if (options.catalogFailure)
        return reject(500, "catalog_failed", "Catalog unavailable");
      const catalog = {
        items: [
          {
            component: "component-sha256",
            name: "coding",
            modes: [
              { name: "plan", role: "main_agent" },
              { name: "build", role: "main_agent" },
            ],
            tools: [],
            variables: {},
          },
        ],
      };
      if (options.holdCatalog) {
        releaseCatalog = () => {
          void reply(catalog);
        };
        return;
      }
      return reply(catalog);
    }
    const other = /^\/api\/v1\/sessions\/([^/]+)\/runtime$/.exec(path);
    const extra = other && others.get(decodeURIComponent(other[1]));
    if (extra) return reply(verb === "PUT" ? extra : extra.session);
    if (path === "/api/v1/sessions") {
      if (verb === "GET")
        return reply({
          unavailable: [],
          complete: true,
          items: [
            ...(!deletedSessions.has(snapshot.session.id)
              ? [snapshot.session]
              : []),
            ...[...others.values()]
              .filter((view) => !deletedSessions.has(view.session.id))
              .map((v) => v.session),
          ],
        });
      if (verb === "POST") {
        return reply(snapshot.session);
      }
    }
    if (path === "/api/v1/sessions/s1") {
      if (verb === "PATCH") {
        if (body.expected_revision !== snapshot.session.revision)
          return reject(409, "revision_conflict", "Session revision changed");
        snapshot.session = {
          ...snapshot.session,
          revision: snapshot.session.revision + 1,
          title: body.title,
        };
        listUpsert(snapshot.session);
        return reply(snapshot.session);
      }
      // Irreversible deletion: the record and its bytes no longer exist.
      if (verb === "DELETE") {
        if (deletedSessions.has("s1"))
          return reply({ deleted: true, session_id: "s1", cleanup: "pending" });
        if (body.expected_revision !== snapshot.session.revision)
          return reject(409, "revision_conflict", "Session revision changed");
        deletedSessions.add("s1");
        setTimeout(() =>
          listEvent("sessions.changed", {
            op: "remove",
            session_id: "s1",
            state: "deleted",
          }),
        );
        return reply({
          deleted: true,
          session_id: "s1",
          cleanup: "pending",
          removed_operation_receipts: 0,
        });
      }
    }
    if (path === "/api/v1/sessions/s1/archive" && verb === "POST") {
      // Archive is idempotent on its target state.
      if (snapshot.session.archived) return reply(snapshot.session);
      if (body.expected_revision !== snapshot.session.revision)
        return reject(409, "revision_conflict", "Session revision changed");
      snapshot.session = {
        ...snapshot.session,
        revision: snapshot.session.revision + 1,
        archived: true,
      };
      listUpsert(snapshot.session);
      return reply(snapshot.session);
    }
    if (path === "/api/v1/sessions/s1/runtime") {
      if (verb === "PUT") {
        snapshot.session.status = "idle";
        return reply(snapshot);
      }
      if (verb === "DELETE") {
        snapshot.session.status = "closed";
        return reply(snapshot.session);
      }
    }
    if (path === "/api/v1/sessions/s1/mode" && verb === "PUT") {
      snapshot.session.mode = body.mode;
      return reply(snapshot);
    }
    if (path === "/api/v1/sessions/s1/children" && verb === "GET")
      return reply({
        parent_session_id: "s1",
        children: children.map(({ id, name, status, availability }) => ({
          id,
          name,
          status,
          availability,
        })),
        next_cursor: null,
        limit: 100,
      });
    if (
      path.startsWith("/api/v1/sessions/s1/children/") &&
      path.endsWith("/enter") &&
      verb === "POST"
    ) {
      const child = children.find(
        (child) => child.id === decodeURIComponent(path.split("/").at(-2)!),
      );
      if (!child || child.interaction !== "persistent")
        return reject(
          409,
          "child_entry_unavailable",
          "Child is not a persistent conversation",
        );
      return reply(child);
    }
    if (path.startsWith("/api/v1/sessions/s1/children/") && verb === "GET") {
      const child = children.find(
        (child) => child.id === decodeURIComponent(path.split("/").at(-1)!),
      );
      if (!child) return reject(404, "unavailable", "Child record unavailable");
      return reply(child);
    }
    if (path === "/api/v1/sessions/s1/permission") {
      if (verb === "GET") return reply(snapshot.permission);
      if (verb === "PUT") {
        if (body.expected_revision !== snapshot.permission.revision)
          return reject(
            409,
            "revision_conflict",
            "Permission revision changed",
          );
        snapshot.permission = {
          revision: snapshot.permission.revision + 1,
          config: {
            ...snapshot.permission.config,
            overrides: body.overrides,
            review: body.review,
            review_model: body.review_model ?? null,
            initialization:
              body.initialization ?? snapshot.permission.config.initialization,
          },
        };
        return reply(snapshot.permission);
      }
    }
    if (
      [
        "/api/v1/sessions/s1/compact",
        "/api/v1/sessions/s1/history/travel",
      ].includes(path) &&
      verb === "POST"
    )
      return reply(snapshot);
    if (path === "/api/v1/sessions/s1/checkpoints" && verb === "POST")
      return reply({ created: true });
    if (path.startsWith("/api/v1/sessions/s1/operations/") && verb === "GET")
      return reply({
        id: decodeURIComponent(path.split("/").at(-1)!),
        status: "completed",
      });
    if (path === "/api/v1/sessions/s1/workspace/files" && verb === "GET")
      return reply({ items: [] });
    return reject(404, "not_found", "API route unavailable");
  });
  await page.routeWebSocket(/\/api\/(?:v1\/)?ws(?:\?.*)?$/, (socket) => {
    nativeUrls.push(socket.url());
    sockets.push(socket);
    socket.onMessage(async (raw) => {
      if (typeof raw !== "string") {
        relayFrames.push(raw);
        return;
      }
      const command = JSON.parse(raw);
      commands.push(command);
      const result = (data: unknown) =>
        socket.send(
          JSON.stringify({
            v: 1,
            type: "result",
            request_id: command.request_id,
            ok: true,
            data,
          }),
        );
      if (command.method === "sessions.watch") {
        listWatch = {
          socket,
          id: `list-${sockets.length}-${commands.length}`,
          generation: `lg-${sockets.length}`,
          sequence: 0,
        };
        result({
          subscription_id: listWatch.id,
          generation: listWatch.generation,
          sequence: 0,
        });
        return;
      }
      if (command.method === "host.relay_attach") {
        attachNativeHost(
          command.params.project_id,
          "connect",
          command.params,
          (value) =>
            result({
              ...value,
              relay_release: {
                relay_id: crypto.randomUUID(),
                relay_generation: String(++relayGeneration),
              },
            }),
          (_status, code, message) =>
            socket.send(
              JSON.stringify({
                v: 1,
                type: "result",
                request_id: command.request_id,
                ok: false,
                error: { code, message },
              }),
            ),
        );
        return;
      }
      if (command.method !== "conversation.binding") {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "result",
            request_id: command.request_id,
            ok: false,
            error: {
              code: "unsupported_method",
              message: "Use the session socket or HTTP resource",
            },
          }),
        );
        return;
      }
      const flavor = command.params.host_flavor;
      if (flavor !== "chat_only" && flavor !== "browser_sandbox") {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "result",
            request_id: command.request_id,
            ok: false,
            error: {
              code: "invalid_params",
              message: "Unsupported Host flavor",
            },
          }),
        );
        return;
      }
      socket.send(
        JSON.stringify({
          v: 1,
          type: "result",
          request_id: command.request_id,
          ok: true,
          data: {
            scope_version: 3,
            scope_kind: "conversation",
            conversation_id: command.params.conversation_id,
            binding_id: "11111111-1111-4111-8111-111111111111",
            backend_id: "22222222-2222-4222-8222-222222222222",
            host_flavor: flavor,
            server_owned: flavor === "chat_only",
          },
        }),
      );
    });
  });
  const pendingSubscriptions: {
    socket: WebSocketRoute;
    sessionId: string;
    frame: Record<string, unknown>;
    view: NativeSnapshot;
  }[] = [];
  let holdNextSubscription = false;
  let holdAllSubscriptions = false;
  let failNextSubscription: { code: string; message: string } | null = null;
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/[^/]+\/ws(?:\?.*)?$/,
    (socket) => {
      sessionSockets.push(socket);
      const sessionId = decodeURIComponent(
        new URL(socket.url()).pathname.split("/")[4],
      );
      const meta = {
        sessionId,
        subscription: `sub-${sessionSockets.length}-${commands.length}`,
        generation: `g-${sessionSockets.length}`,
        sequence: 0,
        established: false,
        closed: false,
        published: null as NativeSnapshot | null,
      };
      connections.set(socket, meta);
      // No server is connected behind this route, so there is no other side to
      // forward the close to; the handler only records it.
      socket.onClose(() => {
        meta.closed = true;
      });
      const view = structuredClone(others.get(sessionId) ?? snapshot);
      view.session.id = sessionId;
      const frame: Record<string, unknown> = {};
      const refusal = failNextSubscription;
      failNextSubscription = null;
      if (refusal) {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "error",
            error: refusal,
          }),
        );
        socket.close();
        return;
      }
      if (holdNextSubscription || holdAllSubscriptions) {
        holdNextSubscription = false;
        pendingSubscriptions.push({ socket, sessionId, frame, view });
      } else {
        const establish = () => initialize(socket, view, frame);
        if (options.attachDelayMs) setTimeout(establish, options.attachDelayMs);
        else establish();
      }
      let clientToolsBound = false;
      socket.onMessage(async (raw) => {
        const command = JSON.parse(String(raw));
        // Test-only route metadata: the wire carries no Session id; authority is
        // the socket path. `sessionId` records that path for routing assertions.
        Object.defineProperty(command, "sessionId", {
          value: sessionId,
          enumerable: false,
        });
        commands.push(command);
        const handled = await options.sessionCommand?.(command, sessionId);
        if (handled) {
          socket.send(
            JSON.stringify(
              "error" in handled
                ? {
                    v: 1,
                    type: "result",
                    request_id: command.request_id,
                    ok: false,
                    error: handled.error,
                  }
                : {
                    v: 1,
                    type: "result",
                    request_id: command.request_id,
                    ok: true,
                    data: handled.data,
                  },
            ),
          );
          return;
        }
        let data: unknown;
        switch (command.method) {
          case "permission.reply": {
            const params = command.params;
            const request = pendingPermissions.find(
              (item) => item.request_id === params.request_id,
            );
            if (
              options.clientTools?.role !== "executor" ||
              params.lease_id !== options.clientTools.lease_id ||
              !request ||
              !["allow", "deny"].includes(params.decision)
            ) {
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: false,
                  error: {
                    code: "permission_executor_required",
                    message: "Current executor lease is required",
                  },
                }),
              );
              return;
            }
            const duplicate = permissionDecisions.has(request.request_id);
            permissionDecisions.set(request.request_id, params.decision);
            data = {
              request_id: request.request_id,
              decision: params.decision,
              remembered: false,
              duplicate,
            };
            break;
          }
          case "client_tools.bind":
            clientToolsBound =
              !!options.clientTools &&
              command.params.catalog_digest ===
                options.clientTools.catalog_digest;
            data = options.clientTools;
            break;
          case "client_tools.arguments": {
            const binding = options.clientTools;
            const call = binding?.pending.find(
              (item) =>
                item.invocation_id === command.params.invocation_id &&
                item.parent_session_id === sessionId &&
                ["pending", "paused"].includes(item.status),
            );
            if (
              !clientToolsBound ||
              meta.closed ||
              binding?.role !== "executor" ||
              !binding.lease_id ||
              command.params.lease_id !== binding.lease_id ||
              !call
            ) {
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: false,
                  error: {
                    code: "executor_required",
                    message:
                      "Current bound executor and exact pending invocation required",
                  },
                }),
              );
              return;
            }
            data = {
              invocation_id: call.invocation_id,
              arguments: structuredClone(call.arguments),
            };
            break;
          }
          case "client_tools.prepare": {
            const call = options.clientTools?.pending.find(
              (call) => call.invocation_id === command.params.invocation_id,
            );
            data = call
              ? {
                  ...call,
                  prepared: true,
                  timeout_result: command.params.timeout_result,
                }
              : {};
            break;
          }
          case "client_tools.result": {
            const call = options.clientTools?.pending.find(
              (call) => call.invocation_id === command.params.invocation_id,
            );
            data = call
              ? {
                  ...call,
                  status: command.params.error ? "failed" : "completed",
                  result: command.params.result,
                  error: command.params.error,
                }
              : {};
            if (call && options.clientTools)
              options.clientTools.pending = options.clientTools.pending.filter(
                (item) => item.invocation_id !== call.invocation_id,
              );
            break;
          }
          case "client_tools.unbind":
            clientToolsBound = false;
            data = { removed: true };
            break;
          case "display.subscribe":
            data = { accepted: true };
            break;
          case "round_limit.reply": {
            const index = pendingRoundLimits.findIndex(
              (request) => request.request_id === command.params.request_id,
            );
            if (index >= 0) pendingRoundLimits.splice(index, 1);
            data = {
              request_id: command.params.request_id,
              decision: command.params.decision,
              duplicate: index < 0,
            };
            break;
          }
          case "turn.queue":
          case "turn.submit":
            if (command.method === "turn.queue" && options.inboxTurn) {
              data = await options.inboxTurn(command);
              break;
            }
            if (options.submitError) {
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: false,
                  error: options.submitError,
                }),
              );
              return;
            }
            snapshot = {
              ...snapshot,
              session: { ...snapshot.session, status: "running" },
              messages: [
                ...snapshot.messages,
                {
                  id: `user-${command.params.operation_id}`,
                  submission_operation_id: command.params.operation_id,
                  role: "user",
                  text: command.params.input.parts[0].text,
                  parts: [],
                  tool_calls: [],
                },
              ],
            };
            data = {
              id: command.params.operation_id,
              method: command.method,
              session_id: sessionId,
              status:
                command.method === "turn.queue" ? "completed" : "accepted",
              result:
                command.method === "turn.queue" ? { admitted: true } : null,
            };
            if (command.method === "turn.queue") {
              snapshot = {
                ...snapshot,
                session: {
                  ...snapshot.session,
                  id: sessionId,
                  status: "running",
                },
              };
              queueMicrotask(() => publish(snapshot));
            }
            break;
          case "inbox.resume":
          case "inbox.update":
          case "inbox.remove":
          case "turn.steer":
            if (options.inboxTurn) {
              data = await options.inboxTurn(command);
              break;
            }
            throw Error("Inbox fixture not configured");
          case "turn.retry":
            if (options.retryTurn) {
              data = await options.retryTurn(command);
              break;
            }
            socket.send(
              JSON.stringify({
                v: 1,
                type: "result",
                request_id: command.request_id,
                ok: false,
                error: {
                  code: "unsupported",
                  message: "Retry fixture not configured",
                },
              }),
            );
            return;
          case "session.blocks": {
            const page: any = await blocksHandler(
              command.params ?? {},
              sessionId,
            );
            if (page?.error) {
              socket.send(
                JSON.stringify({
                  v: 1,
                  type: "result",
                  request_id: command.request_id,
                  ok: false,
                  error: page.error,
                }),
              );
              return;
            }
            data = page;
            break;
          }
          case "session.interrupt":
            data = { requested: true };
            break;
          case "executions.read":
            data = {
              execution_id: command.params.execution_id,
              chunks: [],
              cursor: command.params.cursor ?? 0,
              next_cursor: command.params.cursor ?? 0,
              end_cursor: command.params.cursor ?? 0,
              start_cursor: 0,
              closed: true,
              revision: 1,
            };
            break;
          case "executions.cancel":
            data = {
              requested: true,
              execution_id: command.params.execution_id,
            };
            break;
          default:
            socket.send(
              JSON.stringify({
                v: 1,
                type: "result",
                request_id: command.request_id,
                ok: false,
                error: {
                  code: "unsupported_method",
                  message: `Use the versioned HTTP resource for ${command.method}`,
                },
              }),
            );
            return;
        }
        const reply = () =>
          socket.send(
            JSON.stringify({
              v: 1,
              type: "result",
              request_id: command.request_id,
              ok: true,
              data,
            }),
          );
        if (
          command.method === "round_limit.reply" &&
          options.holdRoundLimitReply
        ) {
          releaseRoundLimitReply = () => {
            options.holdRoundLimitReply = false;
            reply();
          };
          return;
        }
        if (
          command.method === "permission.reply" &&
          options.holdPermissionReply
        ) {
          releasePermissionReply = () => {
            options.holdPermissionReply = false;
            reply();
          };
          return;
        }
        reply();
      });
    },
  );
  function pending() {
    return {
      permissions: options.permissionRequests
        ? {
            parent_session_id: "s1",
            requests: pendingPermissions.filter(
              (item) => !permissionDecisions.has(item.request_id),
            ),
            interactive_ask: true,
            remembered_grants: false,
            executor_connected: options.clientTools?.role === "executor",
          }
        : null,
      round_limits: options.roundLimitRequests
        ? {
            parent_session_id: "s1",
            requests: pendingRoundLimits,
            executor_connected: true,
          }
        : null,
    };
  }
  function initialize(
    socket: WebSocketRoute,
    view: NativeSnapshot,
    frame: Record<string, unknown> = {},
  ) {
    const meta = connections.get(socket)!;
    if (meta.closed) return meta.sequence;
    if (typeof frame.subscription_id === "string")
      meta.subscription = frame.subscription_id;
    if (typeof frame.generation === "string")
      meta.generation = frame.generation;
    if (typeof frame.sequence === "number") meta.sequence = frame.sequence;
    meta.established = true;
    meta.published = structuredClone(view);
    meta.sequence = sendSubscribed(
      socket,
      view,
      meta.subscription,
      meta.generation,
      {
        sequence: meta.sequence,
        sessionId: meta.sessionId,
        pending: pending(),
        frame,
      },
    );
    return meta.sequence;
  }
  function publish(view: NativeSnapshot, offset = 1) {
    const target = committedSocket(view.session.id);
    if (!target || !target[1].published) return;
    const next = structuredClone(view);
    const events = publication(target[1].published, next);
    target[1].published = next;
    events.forEach(([event, data], index) =>
      emitOn(target[0], event, data, index === 0 ? offset : 1),
    );
  }

  return {
    commands,
    requests,
    bridges,
    projects,
    http,
    nativeUrls,
    sockets,
    sessionSockets,
    hostSockets,
    relayFrames,
    pendingSubscriptions,
    /** The next session socket stays open without a `subscribed` frame. */
    holdNextSubscription() {
      holdNextSubscription = true;
    },
    /** The next session socket is refused with an error frame and closed. */
    failNextSubscription(code: string, message: string) {
      failNextSubscription = { code, message };
    },
    /** Holds every later session socket until released (or until `false`). */
    holdSubscriptions(on = true) {
      holdAllSubscriptions = on;
    },
    /** Delivers one held `subscribed` frame, optionally with a replacement
     * snapshot and frame field overrides (for malformed-frame tests). */
    releaseSubscription(
      index = 0,
      replacement?: Record<string, unknown>,
      frame: Record<string, unknown> = {},
    ) {
      const held = pendingSubscriptions.splice(index, 1)[0];
      if (!held) throw Error("No held session subscription");
      return initialize(
        held.socket,
        (replacement ?? held.view) as NativeSnapshot,
        frame,
      );
    },
    /** Refuses one held session socket with an error frame and closes it. */
    refuseSubscription(index: number, code: string, message: string) {
      const held = pendingSubscriptions.splice(index, 1)[0];
      if (!held) throw Error("No held session subscription");
      held.socket.send(
        JSON.stringify({ v: 1, type: "error", error: { code, message } }),
      );
      held.socket.close();
    },
    releaseCatalog: () => releaseCatalog(),
    releasePermissionReply: () => releasePermissionReply(),
    pendingPermissions,
    pendingRoundLimits,
    releaseRoundLimitReply: () => releaseRoundLimitReply(),
    children,
    releaseLogout: () => releaseLogout(),
    /** Sends on the latest established, open socket for `sessionId`, using
     * that socket's own identity and next sequence. Like a Hub publication
     * with no subscriber, it is a no-op when no such socket exists. Tests that
     * address an older socket on purpose send through `sessionSockets[i]`. */
    event(name: string, data: unknown, offset = 1, sessionId = "s1") {
      // Maintain the fixture's authoritative pending set before publishing a live
      // invocation; private fetches still require the bound exact executor lease.
      const call = (data as { call?: ClientInvocation })?.call;
      if (
        name.startsWith("client_tool.") &&
        call &&
        options.clientTools &&
        name !== "client_tool.cancel_requested"
      ) {
        options.clientTools.calls = [
          ...options.clientTools.calls.filter(
            (item) => item.invocation_id !== call.invocation_id,
          ),
          call,
        ];
        options.clientTools.pending = [
          ...options.clientTools.pending.filter(
            (item) => item.invocation_id !== call.invocation_id,
          ),
          ...(["pending", "paused"].includes(call.status) ? [call] : []),
        ];
      }
      if (name === "snapshot")
        throw Error("Whole snapshots are not wire events; use publish(view)");
      const target = committedSocket(sessionId);
      if (name === "session") {
        name = "session.meta";
        data = { session: data };
      }
      if (target) emitOn(target[0], name, data, offset);
    },
    publish,
    listEvent,
    listWatched: () => listWatch !== null,
    handleBlocks(handler: typeof blocksHandler) {
      blocksHandler = handler;
    },
    /** The identity one session socket was accepted with. */
    connection: (socket: WebSocketRoute) => connections.get(socket),
    /** Replaces the Session command hook after `nativeBackend` returns. */
    handleSessionCommand(
      hook: NonNullable<typeof options.sessionCommand> | undefined,
    ) {
      options.sessionCommand = hook;
    },
    finish(text: string) {
      snapshot = {
        ...snapshot,
        session: { ...snapshot.session, status: "idle" },
        messages: [
          ...snapshot.messages,
          {
            id: `m${snapshot.messages.length + 1}`,
            role: "assistant",
            text,
            parts: [],
            tool_calls: [],
          },
        ],
      };
      publish(snapshot);
    },
    snapshot: () => snapshot,
  };
}
