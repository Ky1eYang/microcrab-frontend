import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Exercises emitted Worker/compiler asset URLs rather than Vite's source graph.
 * Build client Components and the frontend before invoking this separate gate. */
export default defineConfig({
  ...base,
  testMatch: [
    "client-plugin-production.spec.ts",
    "client-plugin-editor.spec.ts",
    "settings-ergonomics.spec.ts",
    "settings-redesign.spec.ts",
    "v0116-settings-policy-browser.spec.ts",
    "client-plugin-production-html.spec.ts",
    "client-plugin-packaged-theme.spec.ts",
    "client-plugin-packaged-mcp.spec.ts",
    "client-plugin-workspace.spec.ts",
    "client-plugin-restoration-ui.spec.ts",
    "state-omitted-browser.spec.ts",
    "state-viewer-layout.spec.ts",
  ],
  use: { ...base.use, baseURL: "http://127.0.0.1:18081" },
  webServer: {
    command: "npm run preview -- --port 18081",
    url: "http://127.0.0.1:18081",
    reuseExistingServer: false,
  },
});
