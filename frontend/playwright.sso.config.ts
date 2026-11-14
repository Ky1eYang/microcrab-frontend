import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Independent ephemeral server: leave prior review fixtures/services untouched.
const port = Number(process.env.SSO_TEST_PORT || 18138);
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm run dev -- --strictPort --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
