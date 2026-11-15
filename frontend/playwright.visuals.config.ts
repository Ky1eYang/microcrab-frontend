import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
/** Separate port permits isolated worktree verification alongside the global gate. */
const port = Number(process.env.MICROCRAB_VISUAL_TEST_PORT || "18087");
export default defineConfig({
  ...base,
  testMatch: [
    "rich-visuals.spec.ts",
    "chart-interactions.spec.ts",
    "content-inspection.spec.ts",
  ],
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
