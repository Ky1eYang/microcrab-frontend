import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch:
    /(?:client-tools|todo-history|question-interaction|projector|permission-summary|v0118-units)\.spec\.ts/,
  fullyParallel: true,
});
