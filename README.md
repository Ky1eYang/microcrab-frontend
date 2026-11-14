# microcrab-frontend

Browser UI, WebAssembly client plugins, and browser Host resources for
[microcrab-core](https://github.com/Ky1eYang/microcrab-core).
The React/TypeScript UI lives in `frontend/`; run the following commands from the
repository root.

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

## Plugins and browser Host resources

UI setup/build does not prepare plugin components or browser Host runtime assets.
For the Rust tasks, use an edition-2024-capable Rust toolchain and prefetch the
locked Cargo dependencies separately: the `cargo xtask` alias runs locked and
offline. On Windows, the checked-in Cargo configuration expects `rust-lld.exe`.

Client plugins require the toolchain's `wasm32-unknown-unknown` target and
`wasm-tools` on `PATH`. `npm run plugins:build` installs components and discovery
metadata under `frontend/public/plugins/`. Plugin sources and WIT are retained
under `crates/client/plugins/`.

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
