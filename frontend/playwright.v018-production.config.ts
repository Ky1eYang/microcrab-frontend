import { defineConfig } from "@playwright/test";
import production from "./playwright.production.config";

/** Emitted application acceptance; runtime page imports from /src are excluded. */
export default defineConfig({
  ...production,
  testMatch: [
    ...(production.testMatch as string[]),
    "client-plugin-manager-navigation.spec.ts",
    "prompt-settings.spec.ts",
    "question-markdown-images.spec.ts",
  ],
  // This case deliberately instruments AppStore via Vite's source graph.
  grepInvert: /prompt edits preserve authored CRLF bytes and Session admission omits inherited prompt fields/,
  outputDir: "../../temp/v018-production-tests",
});
