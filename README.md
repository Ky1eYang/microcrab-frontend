# microcrab-frontend

Browser UI, WebAssembly client plugins, and browser Host resources for
[microcrab-core](https://github.com/Ky1eYang/microcrab-core).
The React/TypeScript UI lives in `frontend/`; run the following commands from the
repository root.

The UI supports Chat Only and Sandbox conversations, a workspace picker, file
citations, scoped client plugins and rich Markdown. See the
[visualizer contract](frontend/src/features/visualizers/README.md) for supported
formats, limits and test commands.

## Setup and scripts

Use Node.js 22.12+ and npm, then install the UI's locked dependencies:

```sh
npm run setup
npm run dev
```

The development server listens at `http://127.0.0.1:8080` and proxies `/api`
(including WebSockets) to `http://127.0.0.1:4096`. Run a compatible
[microcrab-apps server](https://github.com/Ky1eYang/microcrab-apps)
separately. Set `MICROCRAB_API_TARGET` in a local `frontend/.env.local` to use a
different backend.

| Root command | Purpose |
| --- | --- |
| `npm run setup` | Run `npm ci` in `frontend/`. |
| `npm run dev` | Start the UI development server. |
| `npm run check` | Run the TypeScript project check. |
| `npm run build` | Check TypeScript and produce `frontend/dist/`. |
| `npm run preview` | Preview the built UI on port 8080. |
| `npm run fixture` | Start the UI fixture server. |
| `npm run test:host` | Run the browser Host source tests with Node.js. |
| `npm run test:browser` | Run Playwright; browser installation and suite-specific servers/assets are prerequisites. |
| `npm run test:browser:unit` / `test:browser:production` / `test:browser:sso` | Select a Playwright suite configuration. |
| `npm run plugins:build` | Build, validate, and install client plugin components. |
| `npm run resources:refresh -- --ref <core-commit>` | Validate browser Host source downloads at a full core commit; add `--write` to replace the snapshot. |

## Conversation workspace modes

New unprojected interactive drafts default to **Chat Only**. The workspace picker
also offers **Sandbox**, which retains the browser virtual filesystem, shell and
Python runtime. Draft selection is remembered per backend and authenticated owner.
Changing the mode allocates a new conversation identity. Existing conversations
keep their immutable Host pins, including Sandbox for existing browser grants.
Projectless delegated or one-shot Sessions do not acquire a browser Host merely
because they have no Project.

Chat Only uses a pure TypeScript protocol peer and loads no browser execution
manifest, Worker or WASM. It advertises no Host tool capabilities or execution
primitives. Agent catalog readiness and the authenticated connection are still
required. Authorized client tools, questions, todos and plugins retain their own
capability and network authorization. Sandbox alone requires the browser execution
resources described below. A compatible Client must support explicit
`conversation.binding.host_flavor` and return the immutable flavor on bindings,
attachments and actual conversation Session projections.

Focused verification: `npm run test:browser -- tests/workspace-modes.spec.ts
tests/default-browser-host.spec.ts tests/browser-host-lifecycle-race.spec.ts`.
The canonical descriptor fixture under `frontend/tests/fixtures/` is shared with
the Client's Rust fingerprint verification; descriptor capability assertions alone
do not certify the actual Agent model tool catalog.

## Native Host mismatch recovery

A `binding_mismatch` response pauses automatic connection attempts for that exact
Project and candidate URL/directory. `host_preflight_unsupported` separately asks
for a Bridge upgrade. The existing API error envelope remains
`{error:{code,message,retryable,details}}`; mismatch guidance uses only closed
Server reasons and does not infer that the Host was upgraded.

These browser-local hints are partitioned by backend, authenticated owner, browser
identity and Project. They survive reload and same-owner authentication changes;
changing the URL or directory selects a new candidate. Only a verified compatible
attachment clears its hint. An explicit **Connect Host** allows one new check,
including a restored compatible Bridge at the same URL. Failed manual checks do
not erase previous incompatibility. At most 128 recent candidate hints are retained;
only candidate hashes and closed classifications are persisted, with an in-memory
fallback when storage is unavailable. This is not Server binding authority.

History and drafts stay available. Recovery uses existing project selection, Host
configuration or a different workspace. The same Host workspace redirects to its
canonical existing Project; recovery never bypasses duplicate-workspace ownership,
rebinds a Project or deletes/archives historical Sessions. Switching the selected
browser relay retains its existing exact route-release semantics; these hints do
not introduce multiple simultaneous selected relays.

Focused source-browser coverage: `frontend/tests/host-mismatch-isolation.spec.ts`.

## Plugins and browser Host resources

UI setup/build does not prepare plugin components or browser Host runtime assets.
For the Rust tasks, use an edition-2024-capable Rust toolchain and prefetch the
locked Cargo dependencies separately: the `cargo xtask` alias runs locked and
offline. On Windows, the checked-in Cargo configuration expects `rust-lld.exe`.

For Rust plugin fixtures, install the toolchain's `wasm32-unknown-unknown` target
and put `wasm-tools` on `PATH`. `npm run plugins:build` installs Rust fixtures and
compatibility components under `frontend/public/plugins/`. The
[plugin tool and MCP contract](docs/client-plugin-tools.md#build-and-acceptance)
has the maintained Zig plugin build and staging instructions. The canonical WIT is
in [`crates/client/plugins/wit`](crates/client/plugins/wit).

For the browser Host, prepare the custom wasmsh **0.5.1** / Pyodide **0.29.3**
distribution separately. Stock Pyodide does not provide the required wasmsh
exports. Supply `browser-host-assets.json` with SHA-256 pins, `pyodide.mjs`, the
asm loader (`pyodide.asm.mjs` or `.js`), `pyodide.asm.wasm`, `python_stdlib.zip`,
`pyodide-lock.json`, and all package files required by the lock and asset manifest:

```sh
cargo xtask browser-host --assets-dir <prepared-pinned-assets-directory>
```

This validates and installs the prepared assets with the checked-in Host sources
under `frontend/public/browser-host/`. It does not download or build the runtime.
Browser execution requires JSPI support. Serve `/browser-host/` and `/plugins/`
from the same origin as the UI, including their discovery pointers and immutable
hashed assets; preserve manifest and SHA-256 validation. Prepare these resources
before a production UI build so they are included in `frontend/dist/`.

Host source refresh is an explicit HTTPS operation against a full 40-character
commit in the core repository. It uses the checked-in `browser-host.sources.json`
and an allowlist in `scripts/refresh-browser-host.mjs`. Without `--write`, it only
validates downloads; with `--write`, it replaces source files and records their
hashes and upstream commit. Runtime binaries are prepared separately.

Generated components, runtime assets, dependencies, build output, and private
configuration are excluded from Git.

## License

MIT; see [LICENSE](LICENSE). Third-party dependencies and prepared runtime assets
retain their respective licenses.
