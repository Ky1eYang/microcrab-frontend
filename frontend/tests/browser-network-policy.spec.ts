import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("browser network policy distinguishes default, deny-all, and exact origins with owner isolation", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const {
      browserHostOrigins,
      saveBrowserHostOrigins,
      resetBrowserHostOrigins,
    } = await import(path);
    const base = `${location.origin}/`;
    const otherBase = "https://another-backend.example/";
    const owner = "policy-owner-a";
    resetBrowserHostOrigins(base, owner);
    const initial = browserHostOrigins(base, owner);
    saveBrowserHostOrigins(base, owner, "");
    const deny = browserHostOrigins(base, owner);
    const foreignOwner = browserHostOrigins(base, "policy-owner-b");
    const foreignBackend = browserHostOrigins(otherBase, owner);
    saveBrowserHostOrigins(
      base,
      owner,
      "https://api.example\nhttps://files.example\nhttps://api.example",
    );
    const exact = browserHostOrigins(base, owner);
    resetBrowserHostOrigins(base, owner);
    return {
      initial,
      deny,
      foreignOwner,
      foreignBackend,
      exact,
      reset: browserHostOrigins(base, owner),
    };
  });
  expect(result).toEqual({
    initial: null,
    deny: [],
    foreignOwner: null,
    foreignBackend: null,
    exact: ["https://api.example", "https://files.example"],
    reset: null,
  });
});

test("malformed saved network policy fails closed and invalid updates preserve the explicit ceiling", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/client/browser-host.ts";
    const {
      browserHostOrigins,
      saveBrowserHostOrigins,
      resetBrowserHostOrigins,
    } = await import(path);
    const base = `${location.origin}/`;
    const owner = "policy-invalid-owner";
    const key = `microcrab.browser-host-network.v1:${JSON.stringify([base, owner])}`;
    const rejected: boolean[] = [];
    for (const raw of ["{", "null", "{}", "[42]"]) {
      localStorage.setItem(key, raw);
      try {
        browserHostOrigins(base, owner);
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    saveBrowserHostOrigins(base, owner, "");
    const invalid: boolean[] = [];
    for (const text of [
      "http://api.example",
      "https://api.example/path",
      "https://user:secret@api.example",
      new URL(base).origin,
    ]) {
      try {
        saveBrowserHostOrigins(base, owner, text);
        invalid.push(false);
      } catch {
        invalid.push(true);
      }
    }
    const retained = browserHostOrigins(base, owner);
    resetBrowserHostOrigins(base, owner);
    return { rejected, invalid, retained };
  });
  expect(result).toEqual({
    rejected: [true, true, true, true],
    invalid: [true, true, true, true],
    retained: [],
  });
});

test("settings distinguishes untouched default from an explicitly empty network ceiling and resets it", async ({
  page,
}) => {
  await nativeBackend(page, { owner: "network-settings-owner" });
  await page.goto("/");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const origins = page.locator("#browser-host-origins");
  await expect(origins).toBeVisible();
  await expect(
    page.getByText("当前使用默认范围：外部 HTTPS Fetch。", { exact: true }),
  ).toBeVisible();
  await origins.fill("");
  await page.getByRole("button", { name: "保存目标上限", exact: true }).click();
  await expect(
    page.getByText("当前使用已保存的来源限制；空列表表示禁止联网。", {
      exact: true,
    }),
  ).toBeVisible();
  const stored = () =>
    page.evaluate(() =>
      localStorage.getItem(
        `microcrab.browser-host-network.v1:${JSON.stringify([`${location.origin}/`, "network-settings-owner"])}`,
      ),
    );
  await expect.poll(stored).toBe("[]");
  await origins.fill("https://api.example");
  await page.getByRole("button", { name: "保存目标上限", exact: true }).click();
  await expect.poll(stored).toBe('["https://api.example"]');
  await page
    .getByRole("button", { name: "恢复默认 Fetch 范围", exact: true })
    .click();
  await expect(
    page.getByText("当前使用默认范围：外部 HTTPS Fetch。", { exact: true }),
  ).toBeVisible();
  await expect(origins).toHaveValue("");
  await expect.poll(stored).toBeNull();
});
