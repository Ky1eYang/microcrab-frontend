import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
const port = Number(process.env.MICROCRAB_VISUAL_PRODUCTION_PORT || "18088");
/** Serve emitted bytes unchanged: no development source transforms. Build with --manifest first. */
export default defineConfig({
  ...base,
  testMatch: "rich-visuals-production.spec.ts",
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm run preview -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
