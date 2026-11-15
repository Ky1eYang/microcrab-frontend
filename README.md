# microcrab-frontend

Browser UI, WebAssembly client plugins, and browser Host resources for
[microcrab-core](https://github.com/Ky1eYang/microcrab-core).
The React/TypeScript UI lives in `frontend/`; run the following commands from the
repository root.

## v0.1.17 baseline

The `v0_1_17` branch tracks this Frontend source baseline and subsequent fixes.
Release tags are not retained; version metadata remains `0.1.17`.
It includes Chat Only/Sandbox mode selection, scoped client-plugin inventory and
State editing, file citations, lazy rich rendering with bounded chart interactions,
and the approved cascading workspace picker/settings redesign. npm and local Rust
workspace packages share version `0.1.17`; dependency pins and WIT/ABI versions
remain unchanged. Compatible Core/Client releases and separately prepared runtime
assets are still required; the source baseline does not bundle binaries or private
configuration.

Implementation acceptance at `9b64191` recorded 128 source-browser cases,
47 emitted-production cases and 2 production lazy-loading/budget cases passing.
The release metadata commit separately passed the locked Rust graph check,
three versioned plugin builds/component validation, TypeScript/Vite production
build, 52 Host source tests, 47 emitted-production cases and 2 lazy-loading/budget
cases. npm dependency/integrity and Rust registry/checksum graphs were unchanged.
These records do not claim a new live Provider/SSO login.

## Setup and scripts

Use Node.js 22.12+ and npm, then install the UI's locked dependencies:

```sh
npm run setup
npm run dev
```

The development server listens at `http://127.0.0.1:8080` and proxies `/api`
(including WebSockets) to `http://127.0.0.1:4096`. Run a compatible
[microcrab-client server](https://github.com/Ky1eYang/microcrab-client)
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
Changing the mode allocates a new conversation identity; existing conversation
Host pins are immutable. Historical browser conversations retain Sandbox through
the Client's persisted conversation grant; projectless delegated or one-shot
Sessions do not acquire a browser Host merely because they have no Project.

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

## Plugins and browser Host resources

UI setup/build does not prepare plugin components or browser Host runtime assets.
For the Rust tasks, use an edition-2024-capable Rust toolchain and prefetch the
locked Cargo dependencies separately: the `cargo xtask` alias runs locked and
offline. On Windows, the checked-in Cargo configuration expects `rust-lld.exe`.

Client plugins require the toolchain's `wasm32-unknown-unknown` target and
`wasm-tools` on `PATH`. `npm run plugins:build` installs components and discovery
metadata under `frontend/public/plugins/`. Plugin sources and WIT are retained
under `crates/client/plugins/`. The [plugin tool and MCP contract](docs/client-plugin-tools.md)
describes the optional asynchronous ABI, external inventory, scoped LocalStorage
resource grants, bounded MCP discovery, and required acceptance checks.

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
hashes and upstream commit. It does not update runtime binaries. The ignored
`split-project.json` is local split bookkeeping and is not required by a clone.

Generated components, runtime assets, dependencies, build output, and private
configuration are excluded from Git. This repository preparation does not imply
that dependency installation, full builds, or browser integration tests passed.

## License

MIT; see [LICENSE](LICENSE). Third-party dependencies and prepared runtime assets
retain their respective licenses.
