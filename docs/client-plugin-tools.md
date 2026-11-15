# Browser plugin tools and MCP bridge

Status: implemented frontend contract with the generic Store adapter integrated
and the retired hardcoded MCP catalog removed. Verification and release status
are tracked by the superproject; no Core Session schema field is added.

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
effects retain a 10-second budget capped by any positive invocation deadline;
cancellation cleanup retains its separate one-second bound. An unbounded invocation
does not grant unbounded network/effect execution or replay authority.

The maintained MCP Bridge declares only `sidebar` and renders no view for other
targets. Its configuration remains available in that Sidebar; it contributes no
Session tab or expanded page. Other plugins retain their declared surfaces.

## Deliberate dual ABI

ABI `microcrab:client-plugin@0.2.0` remains in `crates/client/plugins/wit/` for
maintained visual guests and retained installed bytes. ABI `@0.3.0` is in
`crates/client/plugins/wit-v3/`. Its optional `tool-plugin` world adds `start-tool`
and `cancel-tool`; both must be present together. Visual-only worlds do not gain
mandatory exports. The inspector validates actual imports/exports and the worker
binds only supported exact versions. Production instantiation and WASM execution
remain in a dedicated worker.

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
`resource-configure`. Configuration is available through the MCP plugin's native
surface. The authenticated owner's explicit Add/Update action creates or revokes a
grant; there is no extra permission dialog. A grant binds the application server
origin, owner, plugin ID, exact artifact digest, configured server ID, exact full
HTTP(S) endpoint, POST method, and config revision. Endpoint changes never inherit
credentials from another endpoint. No wildcard origins, redirects, cookies,
ambient credential headers, or arbitrary HTTP methods are admitted.

Configuration and authorization persist in browser LocalStorage under the exact
application-server/owner/plugin namespace. Credentials are host-owned and are not
returned by the resource import or included in model inventories, plugin HTML,
logs, or diagnostics. Native password input state is transient and cleared after
queuing a configuration action. Blank authorization keeps the credential only for
the same endpoint; the explicit Clear credential selector removes it. Disable,
remove, reconfiguration, and cross-tab LocalStorage changes revoke in-flight
network work. Replacing plugin bytes preserves saved configuration/credentials but
revokes executable grants until the owner explicitly authorizes the new artifact.
Corrupt storage and unavailable/quota-exceeded LocalStorage produce bounded
errors; the existing destructive plugin local-data reset clears resource storage
without needing to parse it.

Browser CORS and mixed-content restrictions still apply. The plugin cannot bypass
them; an HTTPS application generally cannot connect to a plain HTTP server.

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

Build all maintained plugin packages together through the root Cargo entry with
explicit `--frontend` and `--install-dir` selections. The workspace metadata-driven
packager discovers MCP automatically, validates the component, publishes immutable
`<id>/<sha256>/plugin.wasm`, and atomically updates the bounded discovery pointer.
Generated bytes remain ignored and are release inputs, not source commits.

Native MCP tests cover RPC identity/unknown outcomes, pagination, schema pins, and
argument validation. `frontend/tests/client-plugin-tool-hub.spec.ts` exercises
LocalStorage/grant isolation, artifact replacement, revocation, incremental live
SSE, a maintained real component/worker asynchronous invocation, two-server MCP
handshake/pagination/calls, schema/config pins, invalid arguments, cancellation,
no replay, and frozen input caching. The maintained runtime suite verifies retained
ABI0.2 visual guests. TypeScript checks and a production frontend build remain
required consumers. Build/compile/test acceptance does not imply deployment.
