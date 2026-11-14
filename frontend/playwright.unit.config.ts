import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch:
    /(?:client-tools|todo-history|question-interaction|projector)\.spec\.ts/,
  fullyParallel: true,
});
