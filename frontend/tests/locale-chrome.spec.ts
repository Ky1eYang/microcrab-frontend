import { expect, test } from "@playwright/test";
import zh from "../src/i18n/locales/zh-CN.json" with { type: "json" };
import en from "../src/i18n/locales/en.json" with { type: "json" };
import { nativeBackend } from "./native-fixture";

const CJK = /[\u4e00-\u9fff]/;
const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("dictionaries have identical keys and placeholder sets", () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  for (const [key, value] of Object.entries(zh))
    expect(placeholders((en as Record<string, string>)[key]), key).toEqual(
      placeholders(value),
    );
});

for (const [locale, chat, trajectory, detached, placeholder] of [
  ["zh-CN", "对话", "轨迹", "未连接", "问点什么，输入 / 查看操作"],
  ["en", "Chat", "Trajectory", "Not connected", "Ask anything, / for actions"],
] as const)
  test(`${locale} header tabs, host chip and composer placeholder are localized`, async ({
    page,
  }) => {
    await page.addInitScript(
      (lo) => localStorage.setItem("microcrab.ui.locale", lo),
      locale,
    );
    await nativeBackend(page);
    await page.goto("/#session/s1");
    await expect(
      page.getByRole("tab", { name: chat, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: trajectory, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("header-host-connection")).toHaveText(
      `Host · ${detached}`,
    );
    await expect(
      page.getByTestId("composer").locator("textarea"),
    ).toHaveAttribute("placeholder", placeholder);
  });

test("en settings and client tools contain no untranslated chrome; live switch back to zh-CN", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await nativeBackend(page);
  await page.goto("/#session/s1");
  await page.locator(".user-card-btn").first().click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  for (const tab of [
    "Backend",
    "Client tools",
    "Appearance",
    "Client info",
    "Data and storage",
  ]) {
    await dialog.getByRole("button", { name: tab, exact: true }).click();
    const text = await dialog.innerText();
    // Fixture content and the 简体中文 endonym may be CJK; chrome must not be.
    expect(
      text.replace(/原生会话|历史提问|历史回答|简体中文/g, ""),
      tab,
    ).not.toMatch(CJK);
  }
  await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByTestId("locale-option-zh-CN").click();
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "对话", exact: true }),
  ).toBeVisible();
});

test('every literal t("key") used in src exists in both dictionaries', async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? walk(path)
        : /\.tsx?$/.test(name)
          ? [path]
          : [];
    });
  const missing: string[] = [];
  for (const file of walk("src"))
    for (const [, key] of readFileSync(file, "utf8").matchAll(
      /\btr?\(\s*"([A-Za-z0-9_.]+[A-Za-z0-9_])"/g,
    ))
      if (!(key in en) || !(key in zh)) missing.push(`${file}: ${key}`);
  expect(missing).toEqual([]);
});
