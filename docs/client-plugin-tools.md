# Browser plugin tools and MCP bridge

The frontend owns client plugin tools and their generic Store adapter. This
contract adds no Core Session schema field.

## Discovery and execution

`CLIENT_TOOL_DEFINITIONS` retains first-party questions and todos and adds one
`plugin` meta-tool. The frontend injects a compact `plugins` external variable as a
visible, persisted, client-owned value into every frozen input operation through
`ClientPlugins.preprocess`. It contains at most 32 enabled, ready tool providers:
ID, bounded name/description, version, and a 16-lowercase-hex artifact reference.
The reference is bound to the exact component SHA-256 in a host-only persisted
owner/server/plugin-scoped ledger. It contains no
server endpoints or credentials. Plugin preprocessing cannot overwrite this value.
Unknown admissions reuse the same cached input bytes; bypass and no-registry paths
share the 128-operation bound and cache. Core permits visible/persisted,
invisible/persisted, and invisible/ephemeral custom variables; visible/ephemeral
input is rejected during real inbox admission. The compact non-sensitive summary
therefore persists as the last submitted observation and is refreshed (including
to an empty inventory) on each new input operation. Frozen admitted input/history
retains its original summary. The summary never grants plugin/tool/network
authority: dispatch still checks live owner, enablement, artifact and target pins.

New catalogs use one flat closed object schema for `plugin`: `plugin`, `artifact`,
`action`, `server`, `tool`, `pin`, `arguments`, `config_pin`, `schema_pin`, `cursor`, `limit`.
Only the first three fields are globally required; runtime action validators keep the
same conditional requirements, mutual exclusions, exact pins and bounds. Flattening
removes conditional `oneOf`/Boolean-false branches from the advertised schema; it is
a compatibility mitigation, not proof of the cause of all-null arguments. Browser
semantic checks still reject invalid action combinations before effects, potentially
after normal permission admission. An exact recognized
frozen short16 `oneOf` catalog still receives short inventory; unknown legacy schemas
retain full64 compatibility. New definitions never rewrite a frozen Context epoch.

A plugin's release `version` is descriptive, code-side update metadata. It does not
identify executable bytes, authorize effects, select automatic updates, or impose a
framework release-version gate. Runtime artifact identity is the full SHA-256 of
the installed WASM Component; changing bytes changes that identity even when the
plugin ID and release version stay the same. Plugin IDs retain their namespace and
target-selection role. Supported WIT ABI and storage/schema versions are separate
compatibility contracts and remain validated independently.

The host-only IndexedDB settings ledger retains at most 8192 immutable
`plugin-ID:short-reference -> full-SHA256 | ambiguous` bindings. Registration is an
atomic transaction across tabs, before a provider can advertise its reference.
Ordinary remove/reset/replacement never clears or reassigns a binding. Known
collisions persist as ambiguity tombstones and exclude that provider from short
model inventory, with a concrete diagnostic; explicit full64 compatibility dispatch
remains possible. Storage corruption, quota exhaustion and unavailable storage fail
closed without eviction. Short dispatch rereads the binding and fences awaited reads
against instance, Session and history changes before any guest effect.

The browser ledger stores canonical resolution separately from immutable admitted
model arguments. Server call arguments/history retain their original reference text;
they are not silently rewritten or re-admitted. New/draft and known current-catalog
Sessions advertise short artifacts. A selected Session whose actual frozen plugin
schema is legacy64-only or unknown conservatively receives full artifact inventory
on new input operations, resolved from the same installed exact provider. This
compatibility projection does not change tool definitions or already prepared input;
release numbers never select it. Whole browser site-data deletion is
an explicit authority/data loss boundary, not a reference migration mechanism.

`list` without a server aggregates enabled, authorized servers' tool summaries in
bounded pages. `limit` caps total summaries per page (default20, maximum32), not each
server's contribution. Discovery failures are explicit per-server errors while
successful peers remain available. `describe(server)` is graceful paged server tool
discovery; `describe(server, tool)` returns its exact schema and 16-hex informational
config/schema pins plus `call_pin`.

Use `call(pin, arguments)` with required plugin ID and short artifact reference;
redundant server/tool/config/schema fields with pin are rejected. Legacy pinless
exact server/tool/config/schema calls and full64 artifacts remain accepted for
retained inputs and generic providers. Short config/schema legacy values require a
unique exact retained observation; full internal identities are checked before any
effect. A short reference never guesses another target. Generic providers can use
a stable `default` service ID. A plugin with views alone is not a tool provider and
stays compatible. Delegated sessions cannot borrow the selected main Session's
registry or grants; absent their own registry, plugin calls fail.

The existing controller remains the sole execution-lease owner. Its external
adapter receives immutable invocation metadata and AbortSignal. It preserves
cancellation, deadline, no replay, durable reconciliation, and the 64-KiB result
budget. The registry also remembers bounded invocation IDs and rejects duplicates.
A nonpositive `deadline_ms` means no external invocation deadline: dispatch and
asynchronous context checks remain live until completion or explicit cancellation,
and no expiry timer is armed. Positive deadlines expire normally. Individual Host
HTTP effects use the plugin's Host-owned `request_timeout_ms` preference: default
10000 ms, integer bounds10000–300000 ms. Plugin manager → select any plugin →
HTTP request timeout (seconds) → Save timeout configures10–300 seconds;120 seconds
is suggested for long requests. The preference is public Host configuration, stored
per server origin, authenticated owner and plugin id; it survives reload, artifact
replacement and local-data reset/removal, independently of guest KV and endpoint
credentials. No plugin-specific Host branch or declared SettingPage is required.

The optional additive JSON context field `host_http_timeout_ms` exposes the trusted
invocation snapshot without changing WIT ABI0.4. Direct `net.http` and configured
resource HTTP GET/POST share one registry timer. Guests must snapshot this value
with each pending HTTP task, so their observational retention cannot expire before
that task's original Host deadline. A preference edit affects future invocations;
it never shortens an in-flight request. The Host uses its own captured context,
never a guest payload or returned Worker context, as timer authority. Existing
positive tool deadlines still cap HTTP and cancellation cleanup keeps its separate
one-second bound. Non-HTTP effects retain10 seconds; synchronous Worker calls,
mutation ACK observation and WebSocket limits are independent. Timeout replies retain
`plugin host effect exceeded <effective-ms>ms deadline`. No deadline or cancellation
permits automatic replay or grants additional endpoint/owner authority.

The maintained Zig MCP Bridge declares `sidebar` and `setting-page`: Sidebar is
observation-only, while SettingPage owns server configuration. It contributes no
Session tab or expanded page. The maintained Zig State Viewer declares only
`sidebar` and `expanded-page`; it has no plugin parameters or SettingPage.
The Rust State Viewer behavioral fixture also declares `setting-page`. With no
selected Session, that fixture returns an English/Chinese Session-required notice
before any State import, using the host's flat `ctx.session_id` and `ctx.locale` fields.

## Participation and private dispatch

New catalogs include the first-party `request_secret` human interaction beside
questions/todos. Registry declarations distinguish human replies from ordinary plugin
producer work. Every authenticated same-owner bound participant may submit/decline an
exact pending human request; only the current executor runs ordinary plugin calls or
submits producer output. Public records retain original placeholders and sanitized
receipts. The exact live executor retrieves resolved arguments through the private
`client_tools.arguments` response immediately before dispatch; that value is not placed
in application state, bind snapshots or generic history. Cancellation revokes retrieval.

Secret input uses uncontrolled masked DOM fields, dedicated operation UUIDs and
read-only operation observation after unknown acknowledgements. Public completion means
the private write finished, not that an ephemeral value survives restart. Framework
literal output masking does not make downstream guest memory or external endpoints a
certified transient store; authorized guests may retain their own argument copies.

## Explicit versioned ABI

The runtime supports only `microcrab:client-plugin@0.4.0`, defined by the single
canonical `crates/client/plugins/wit/client-plugin.wit`. Maintained State Viewer,
fixture and MCP guests bind to this directory. `view-target` includes `setting-page`.
Both visual-only worlds and the optional `tool-plugin` world support settings
surfaces; adding a target does not grant State, resource, network or tool authority.

The optional `tool-plugin` world adds `start-tool` and `cancel-tool`; both must be
present together. Visual-only worlds do not gain mandatory tool exports. The
inspector validates actual imports/exports and the Worker binds exact 0.4.0 imports.
Production instantiation and WASM execution remain in a dedicated Worker. Type-only
imports never grant effect capabilities.

HTML `render-view` envelopes may declare `view_state: {"$ref":"state"}` to bind
an explicit plugin variable subtree. Only an exact single-key root object is a
binding; objects with additional keys and nested `$ref` objects remain literal JSON.
Paths must be nonempty, at most512 characters, resolve through own properties,
and exclude prototype segments and the whole Vars root. A missing path is an error;
explicit JSON null is valid. Each variable update validates all mounted projections
before committing: the existing64-KiB/depth24/4096-node HTML message limits apply.
Ordinary `vars_patch` updates then push the projection through the existing channel
without a structural render or document replacement. Keep `rerender:false` when only
projection data changes. HTML BlockSlot `view_state` remains literal.

Installed 0.2/0.3 Components fail with a concrete unsupported-import diagnostic.
Their bytes, preferences and KV remain retained; startup never silently upgrades an
unsupported ABI through bundled predecessor repair. Explicit owner replacement is
required, and no mutation is replayed to migrate an old guest.

From the Frontend repository root, run `npm --prefix frontend run test:plugin-abi`.
The gate checks that real retained 0.2/0.3 Components are rejected before
execution, then exercises built 0.4 Components using the actual inspector,
jco instantiation, typed manifests, renders and optional tool exports. The outer
`cargo xtask wasm zig-plugins` stages the maintained Zig guests;
`cargo xtask wasm plugins` stages the Rust behavioral fixtures. Select and stage
those graphs explicitly before the matching browser gate.
The gate requires retained immutable old Component assets in
`frontend/public/plugins`; these generated assets are local prerequisites, not
tracked source fixtures. Missing old evidence fails the gate instead of substituting
framing-only synthetic modules.

`start-tool(request,ctx)` returns an immediate `PluginResult.tool_completion` with
`pending`, `completed`, or `failed`. Imports still queue request IDs. Their results
arrive through `on-phase("event-result",...)`; the guest can issue the next request
or return a terminal completion. The serial worker queue is released after the
synchronous start acknowledgement, before the tool promise is awaited.
Completions echo the full host-owned `tool_invocation`: invocation, parent/current
Session, call, catalog digest, epoch, turn/round, history anchor, artifact,
worker generation, history generation, and deadline. The registry rechecks origin
freshness at event dequeue and fences late responses, history resets, replacement,
disablement, owner/Session changes, and cancellation.

Model tool dispatch grants no hidden surface authority. State writes, plugin KV
writes, conversation decorations, and resource configuration require an explicit
owner surface action. Model-triggered network work requires an exact configured
resource reference. Actual component imports remain necessary independently.

## Resource configuration and credentials

The generic `resources` import provides queued `resource-list` and
`resource-configure`. Together with the actual `net` Component import it lets any
plugin use owner-approved HTTP(S) endpoints, even outside its static
`network_origins`. The authenticated owner's explicit surface action is required to
configure a grant. A grant binds the application server origin, owner, plugin ID,
exact artifact digest, resource ID, exact full URL (including path and query),
allowed HTTP methods, and `config_pin` revision. No endpoint prefixes or wildcards
are granted; endpoint changes never inherit another endpoint's credential.

`resource-configure` optionally takes `methods`, a nonempty distinct uppercase
list drawn from `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`.
An enabled resource supplied with this field requires a separate localized Host
approval showing the plugin, exact endpoint and methods, but not the authorization
header. Decline, scope retirement, or the 60-second approval deadline cannot save
that draft. Missing `methods` means `['POST']`, with the established explicit
Add/Update action (no additional prompt) for legacy MCP and Output Translator.
`resource-list` reports approved methods, never the saved credential. `net.request`
`http` requests use `resource`, `config_pin`, and the desired `method` (default
`POST` for resources). If supplied, `url` must be exactly the stored URL. A
registered grant allows follow-up requests in the original current scope without
another click; model tool dispatch cannot configure it or use direct-origin egress.
Existing static `network_origins` requests retain their original policy.

Configuration and authorization persist in browser LocalStorage under the exact
application-server/owner/plugin namespace. Persisted credentials are host-owned and
are not returned by the resource import or included in model inventories, projected
HTML view_state, Vars, histories, logs or diagnostics. The user-approved HTML form
may temporarily contain a newly entered password and send it in one fenced save
action; DOM and guest transient buffers are immediately cleared after queuing. Guest
HTML can observe that new input; this grants no readback of saved credentials.
Blank authorization keeps the credential only for
the same endpoint; the explicit Clear credential selector removes it. Disable,
remove, reconfiguration, and cross-tab LocalStorage changes revoke in-flight
network work. Replacing plugin bytes preserves saved configuration/credentials but
revokes executable grants until the owner explicitly authorizes the new artifact.
Corrupt storage and unavailable/quota-exceeded LocalStorage produce bounded
errors; the existing destructive plugin local-data reset clears resource storage
without needing to parse it.

Browser fetch uses CORS, rejects redirects, omits cookies and browser HTTP-auth
credentials, and sends no referrer or frontend login token. Mixed-content rules
still apply; an HTTPS application generally cannot connect to a plain HTTP server.

### Incremental SSE

Set `response_mode: "sse"` on an `http` request with an exact configured resource;
`response_id` (the separate MCP JSON-RPC matching mode) must be absent. The Host
requests `Accept: text/event-stream`. Each complete data event arrives through
`on-phase("event-result", ...)` as `{request_id,ok:true,value:{type:"sse-event",event,data,id?}}`.
Unnamed events use `message`; multiline data uses LF; `id` is the last valid SSE
ID once set. A stream is not an EventSource and does not automatically reconnect.
SSE wire bytes are capped at 2 MiB, frames at 64 KiB, and events at 4096. There is
one active stream per plugin Worker. The first frame is delivered at least 500 ms
after response headers, and the next at least 500 ms after the previous Worker
acknowledgement, without dropping frames. Comments do not generate callbacks. Incomplete trailing
frames at EOF are discarded. The stream response excludes credential headers and
redacts literal echoes of the saved authorization value and conventional token;
this is not detection of encoded, split or transformed secrets, so approve only
trusted endpoints.

Normal EOF returns one usual terminal `{request_id,ok:true,value:{status,headers,body:""}}`
after all delivered frames. Non-2xx responses return that status without any
frames; 2xx without an SSE body is an error. Current-scope transport, parsing,
quota and timeout failures use the usual `{request_id,ok:false,error}`. The plugin
HTTP timeout is an absolute deadline for fetch, frame delivery and EOF (10 seconds
by default; owner adjustable up to 300); a model invocation can shorten it further.
Session/history/owner/surface/tool retirement aborts the original request and drops
stale callbacks; revoking or reconfiguring the resource aborts and fences its frames.
No effect is replayed, no network is delegated to the Server, and ABI 0.4 is unchanged.

## MCP service contract

`microcrab-client-plugin-mcp-bridge` owns initialization, protocol negotiation,
multiple configured services, JSON-RPC identities, session headers, pagination,
exact schema discovery, argument validation, calls, and cancellation notifications.
The browser frontend core contains only generic plugin/resource/transport owners.
The guest supports negotiated versions `2025-11-25`, `2025-06-18`, and `2025-03-26`.
Each invocation initializes its exact configured server explicitly; no request is
retried or rerouted. Notifications require HTTP 202/204 acknowledgements.

POST responses negotiate JSON and SSE. The generic reader incrementally decodes
UTF-8, handles LF, CR, and split CRLF framing, limits response data to 2 MiB and
4096 data events, and cancels the reader immediately after the exact matching RPC
response. It does not wait for a live stream to close. Server requests and mismatched
response IDs are rejected. No background GET stream is opened. Abort/deadline
cancels transport; the guest can send one separate best-effort cancellation
notification under one second of host cleanup authority. This never retries the
original tool effect. A dispatched call with a transport/protocol failure reports
an unknown outcome; upstream RPC errors are sanitized and retain known rejection.

Remote catalogs are bounded to 100 pages, 1000 unique tools, and 2 MiB per server.
Repeated or invalid remote cursors and duplicate names fail. Hub pages contain at
most `limit` tool summaries, with explicit empty/error server entries consuming no
tool budget. Aggregate discovery sorts at most32 resources by ID and refreshes each
sequentially per page. Only the current server retains its bounded full catalog;
across servers the operation retains at most32 requested summaries plus32 full
fingerprint/count/error records. It performs no background discovery.

A separate FIFO256 scoped cursor map retains full inventory/config/catalog digests.
Model cursors are 16-hex opaque references, with no raw revision or full digest
serialized inside them. Full inventory and scope validate before network; refreshed
catalog fingerprints validate before a page is returned. Changes in config, enabled
inventory, remote catalogs or errors, Context/history/Session scope, worker restart,
eviction or known collisions reject stale pagination. Model-facing config/schema/
catalog pins are informational16; tool schemas retain full internal SHA-256 and are
revalidated immediately before an effect. Host network grants compare exact revision
identifiers, never truncated hashes.

The guest retains at most 256 described call references in FIFO order, bound to
Session/parent, artifact/worker generation, history generation, Context epoch, and
catalog identity. Each short reference maps to the exact server, tool, full config
revision and full schema SHA-256. Calls contact only that server, refresh its schema,
and validate arguments before `tools/call`. Unknown, expired, conflicting or ambiguous
references fail without dispatch; short-hash collisions never choose a candidate by
iteration order. Worker restart or eviction requires another explicit `describe`;
there is no automatic rediscovery/retry of effects. The short reference is neither
a shortened WASM identity nor a resource authorization grant. Results reserve room
below the existing durable bridge budget; oversized results fail without replay.

Argument validation supports a bounded, fail-closed JSON Schema subset: booleans,
local JSON Pointer references, type/enum/const, object properties/required/additional
properties and counts, array items/counts/uniqueness, string lengths, numeric bounds
and multipleOf, and allOf/anyOf/oneOf/not. Annotations and local definitions are
accepted. Validation depth is 32 and each schema/evaluation has an 8192-step budget.
Unsupported keywords (including regex patterns/formats and conditional schemas),
remote references, malformed schemas, missing required arguments, wrong types,
and forbidden extra properties reject before `tools/call`. There are no implicit
defaults, argument coercions, regex execution, or remote schema fetches.

## Build and acceptance

From the superproject root, build and stage the maintained Zig plugins with:

```sh
cargo xtask wasm zig-plugins -p state-viewer -p mcp-bridge --install-dir microcrab-frontend/frontend/public/plugins
```

Use `--frontend-plugins PATH` to select a different Zig checkout. Omit
`--install-dir` for a build and validation without installation. Optimization
defaults to ReleaseSmall. Zig registrations own IDs, worlds and assets, with
cache-generated HTML. Direct `zig build install-frontend`
aggregates both approved public directories; an explicit destination replaces these
defaults. Installation preserves unrelated entries/defaults, verifies immutable bytes,
and atomically merges one bounded pointer per destination under locks. Explicit
adopt-current verifies the previous selected package before retaining its exact hash;
no artifact hash is hardcoded. The legacy `wasm plugins` Rust package entry remains
for explicit behavioral fixtures and compatibility, never an implicit concurrent
publisher. Generated bytes remain ignored release inputs, not source commits.

Zig native tests cover protocol, pins/cursors, fail-closed schemas, operation cleanup,
history/projection budgets and secret clearing. `frontend/tests/zig-mcp-bridge.spec.ts`
uses the real Zig Component and Worker for protocol/UI/cancellation/history gates;
`frontend/tests/client-plugin-packaged-mcp.spec.ts` consumes the actual assembled app.

Native MCP tests cover RPC identity/unknown outcomes, pagination, schema pins, and
argument validation. `frontend/tests/client-plugin-tool-hub.spec.ts` exercises
LocalStorage/grant isolation, artifact replacement, revocation, incremental live
SSE, a maintained real component/worker asynchronous invocation, two-server MCP
handshake/pagination/calls, schema/config pins, invalid arguments, cancellation,
no replay, and frozen input caching. Run the ABI gate above for retained-component
rejection. Run `npm run check` and `npm run build` from the Frontend repository
root to check TypeScript and build the production application.
