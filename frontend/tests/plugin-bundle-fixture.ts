import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Snapshot built maintained guests, independently of concurrently edited public pointers.
 * Build first with the outer `cargo xtask wasm plugins` command. An explicit directory
 * supports standalone checkouts and alternate outer target roots without fixed hashes.
 */
export async function maintainedPluginBundle(page: Page) {
  const componentRoot = resolve(import.meta.dirname, "../..");
  const directory = process.env.MICROCRAB_TEST_PLUGIN_DIR
    ? resolve(process.env.MICROCRAB_TEST_PLUGIN_DIR)
    : resolve(componentRoot, "../target/root-build/frontend/client-plugins");
  const assets = ["fixture", "mcp-bridge", "state-viewer"].map((name) => {
    const metadata = readFileSync(
      resolve(componentRoot, `crates/client/plugins/${name}/Cargo.toml`),
      "utf8",
    )
      .split("[package.metadata.microcrab]")[1]
      ?.split(/\n\[/)[0];
    if (!metadata)
      throw new Error(`Missing maintained plugin metadata: ${name}`);
    const id = /^plugin-id\s*=\s*"([^"]+)"/m.exec(metadata)?.[1];
    const component = /^component-name\s*=\s*"([^"]+)"/m.exec(metadata)?.[1];
    const enabled = /^default-enabled\s*=\s*(true|false)/m.exec(metadata)?.[1];
    if (!id || !component || !enabled)
      throw new Error(`Invalid maintained plugin metadata: ${name}`);
    const bytes = readFileSync(resolve(directory, `${component}.wasm`));
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([0, 97, 115, 109, 13, 0, 1, 0])) ||
      !bytes.includes(Buffer.from("microcrab:client-plugin/view-types@0.4.0"))
    )
      throw new Error(
        `Expected built ABI 0.4 Component: ${component}; rebuild maintained plugin assets`,
      );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const predecessors = /supersedes\s*=\s*\[([^\]]*)\]/s.exec(metadata)?.[1];
    const supersedes = predecessors
      ? [...predecessors.matchAll(/"([a-f0-9]{64})"/g)].map(
          (match) => match[1]!,
        )
      : [];
    return {
      bytes,
      record: {
        id,
        file: `${id}/${sha256}/plugin.wasm`,
        sha256,
        default_enabled: enabled === "true",
        ...(supersedes.length ? { supersedes } : {}),
      },
    };
  });
  const index = { version: 1, plugins: assets.map(({ record }) => record) };
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({
      json: index,
      headers: { "cache-control": "no-store" },
    }),
  );
  for (const { record, bytes } of assets) {
    await page.route(`**/plugins/${record.file}`, (route) =>
      route.fulfill({
        contentType: "application/wasm",
        body: bytes,
        headers: { "cache-control": "no-store" },
      }),
    );
  }
  return index;
}
