import { expect, test } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Run after `npm run build -- --manifest`. This checks emitted production artifacts.
test("production static entry excludes rich engines, CSS and glyph fonts", () => {
  const dist = resolve(import.meta.dirname, "../dist");
  const manifest = JSON.parse(
    readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"),
  );
  const staticKeys = new Set<string>();
  const walk = (key: string) => {
    if (staticKeys.has(key)) return;
    staticKeys.add(key);
    for (const dep of manifest[key]?.imports ?? []) walk(dep);
  };
  walk("index.html");
  const eager = [...staticKeys].flatMap((key) => [
    manifest[key].file,
    ...(manifest[key].css ?? []),
    ...(manifest[key].assets ?? []),
  ]);
  expect(
    eager.filter((file) =>
      /mermaid|echarts|math-engine|katex|\.(?:woff2?|ttf)/i.test(file),
    ),
  ).toEqual([]);
  const budgets: Record<string, number> = {
    "mermaid.core": 180000,
    "echarts-engine": 220000,
    katex: 90000,
    "math-engine": 12000,
  };
  for (const [label, limit] of Object.entries(budgets)) {
    const entry = Object.values(manifest).find((entry: any) =>
      entry.file.includes(`/` + label + "-"),
    ) as any;
    expect(entry, label).toBeTruthy();
    const file = resolve(dist, entry.file);
    const gzipBytes = gzipSync(readFileSync(file)).byteLength;
    expect(gzipBytes, label).toBeLessThan(limit);
    console.log(
      `${label}: ${statSync(file).size} raw bytes; ${gzipBytes} gzip bytes (limit ${limit})`,
    );
  }
  const math = Object.values(manifest).find(
    (entry: any) =>
      entry.file.includes("/math-engine-") && entry.file.endsWith(".js"),
  ) as any;
  expect(math.css.some((file: string) => file.includes("math-engine"))).toBe(
    true,
  );
});

test("production startup requests zero rich engine/font assets", async ({
  page,
}) => {
  const resources: string[] = [];
  page.on("request", (request) => resources.push(request.url()));
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/index.html");
  await expect
    .poll(() => resources.some((url) => /assets\/index-.*\.js/.test(url)))
    .toBe(true);
  await page.waitForLoadState("networkidle");
  expect(
    resources.filter((url) =>
      /mermaid|echarts|katex|math-engine|\.(?:woff2?|ttf)(?:\?|$)/i.test(url),
    ),
  ).toEqual([]);
});
