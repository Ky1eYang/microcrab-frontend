import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

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
    plugins: [react(), browserWasmTools()],
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
