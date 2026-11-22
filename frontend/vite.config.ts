import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { version } from "./package.json";

/** Bind the fingerprint to the HTML that loaded this UI, not a mutable sidecar. */
function frontendBuildIdentity(): Plugin {
  return {
    name: "microcrab-frontend-build-identity",
    apply: "build",
    generateBundle: {
      order: "post",
      handler(_, bundle) {
        const index = bundle["index.html"];
        if (
          index?.type !== "asset" ||
          typeof index.source !== "string" ||
          !index.source.includes("</head>")
        )
          this.error("Cannot attach frontend build identity: missing HTML head");
        const digest = createHash("sha256");
        for (const name of Object.keys(bundle).sort()) {
          const entry = bundle[name];
          const bytes = Buffer.from(entry.type === "chunk" ? entry.code : entry.source);
          // Frame both name and payload length so boundaries are unambiguous.
          digest.update(JSON.stringify([name, bytes.length]) + "\n").update(bytes);
        }
        index.source = index.source.replace(
          "</head>",
          `  <meta name="microcrab-frontend-sha256" content="${digest.digest("hex")}" />\n  </head>`,
        );
      },
    },
  };
}

const browserWasmTools = () => ({
  name: "browser-wasm-tools-memory-only",
  enforce: "pre" as const,
  transform(_source: string, id: string) {
    if (
      id
        .replaceAll("\\", "/")
        .split("?")[0]
        ?.endsWith("/@bytecodealliance/jco-transpile/dist/preopens.js")
    )
      return {
        code: 'export function ensureWitFilesystemPreopen() { throw new Error("Browser component packaging only accepts in-memory bytes; filesystem WIT paths are unavailable"); }',
        map: null,
      };
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "");
  const target = env.MICROCRAB_API_TARGET || "http://127.0.0.1:4096";
  const proxy = { "/api": { target, ws: true, changeOrigin: false } };
  return {
    plugins: [react(), browserWasmTools(), frontendBuildIdentity()],
    define: { __MICROCRAB_FRONTEND_VERSION__: JSON.stringify(version) },
    base: "./",
    // jco's compiler loads sibling .wasm files through import.meta.url. Flattening
    // this module into the dependency cache changes that URL into an HTML fallback.
    optimizeDeps: {
      exclude: [
        "@bytecodealliance/jco",
        "@bytecodealliance/jco/component",
        "@bytecodealliance/jco-transpile",
        "@bytecodealliance/jco-transpile/component",
        "@bytecodealliance/jco-transpile/wasm-tools",
      ],
    },
    worker: { format: "es", plugins: () => [browserWasmTools()] },
    build: {
      manifest: true,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            markdown: ["react-markdown", "remark-gfm"],
          },
        },
      },
    },
    server: {
      strictPort: true,
      watch: { ignored: ["**/*.tmpdir/**"] },
      proxy,
    },
    preview: { strictPort: true, proxy },
  };
});
