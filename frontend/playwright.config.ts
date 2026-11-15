import { defineConfig } from "@playwright/test";

const port = Number(process.env.MICROCRAB_TEST_PORT ?? "18080");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("MICROCRAB_TEST_PORT must be an integer from 1024 to 65535");

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
