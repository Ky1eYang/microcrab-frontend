import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import {
  resetSimpleRules,
  setSimpleToolRule,
} from "../src/features/popups/SessionPermissionsDialog/rules";
import type {
  Permission,
  PolicySnapshot,
  SessionPermissionConfig,
} from "../src/client/types";

const opaque: Permission[] = [
  {
    tool: { kind: "glob", value: "*" },
    action: "ask",
    args: [{ pointer: "/safe", matcher: { kind: "exact", value: "true" } }],
  },
  { tool: { kind: "exact", value: "pwsh" }, action: "deny" },
];
function policy(): PolicySnapshot {
  const config: SessionPermissionConfig = {
    agent: "coding",
    mode: "execute",
    overrides: structuredClone(opaque),
    review: true,
    initialization: "ask",
    defaults: [
      {
        tool: { kind: "exact", value: "pwsh" },
        action: "ask",
      },
    ],
  };
  return {
    revision: 7,
    config,
    tool_inventory: {
      agent: "coding",
      modes: [
        {
          name: "execute",
          current: true,
          tools: [{ name: "pwsh", description: "Pinned shell" }],
          policy: config,
          compiled: [
            {
              tool: { kind: "exact", value: "pwsh" },
              kind: "static",
              action: "deny",
            },
          ],
        },
        {
          name: "plan",
          current: false,
          tools: [{ name: "read", description: "Pinned reader" }],
          policy: { ...config, mode: "plan" },
          compiled: [
            {
              tool: { kind: "exact", value: "read" },
              kind: "static",
              action: "allow",
            },
          ],
        },
      ],
    },
  };
}
test("simple scoped reset preserves opaque rules and global selectors in order", () => {
  const original = policy();
  const changed = setSimpleToolRule(
    original.config,
    "coding",
    "execute",
    "pwsh",
    "allow",
  );
  expect(changed.overrides.slice(0, 2)).toEqual(opaque);
  expect(changed.overrides.at(-1)).toEqual({
    agent: "coding",
    mode: "execute",
    tool: { kind: "exact", value: "pwsh" },
    action: "allow",
  });
  expect(resetSimpleRules(changed, original.tool_inventory).overrides).toEqual(
    opaque,
  );
  expect(original.config.overrides).toEqual(opaque);
});

test("composer opens pinned modes and sends exact scoped rules and model identity", async ({
  page,
}) => {
  await nativeBackend(page);
  let current = policy();
  let sent: any;
  await page.route("**/api/v1/sessions/s1/permission", async (route) => {
    if (route.request().method() === "PUT") {
      sent = route.request().postDataJSON();
      current = {
        ...current,
        revision: 8,
        config: {
          ...current.config,
          overrides: sent.overrides,
          review: sent.review,
          review_model: sent.review_model,
          initialization: sent.initialization,
        },
      };
    }
    await route.fulfill({ json: current });
  });
  await page.goto("/#session/s1");
  const entry = page.getByTestId("composer-session-permissions");
  await expect(entry).toBeEnabled();
  expect(
    await entry.evaluate(
      (element) =>
        !!element.previousElementSibling?.classList.contains(
          "composer-plus-wrap",
        ),
    ),
  ).toBe(true);
  await entry.click();
  const dialog = page.getByTestId("session-permissions");
  await expect(dialog.getByText("Pinned shell", { exact: true })).toBeVisible();
  await expect(
    dialog
      .getByTestId("session-permission-policy-fact")
      .filter({ hasText: "已保存服务端策略" }),
  ).toContainText("拒绝");
  await expect(
    dialog.getByTestId("session-permission-policy-fact"),
  ).toContainText("当前模式");
  await expect(
    dialog.getByTestId("session-permission-draft-label"),
  ).toContainText("已保存配置");
  await dialog.getByRole("tab", { name: "coding · plan", exact: true }).click();
  await expect(
    dialog.getByTestId("session-permission-policy-fact"),
  ).toContainText("假设模式预览");
  await expect(
    dialog.getByText("Pinned reader", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "read 的调用策略" })
    .selectOption("deny");
  await expect(
    dialog.getByTestId("session-permission-draft-label"),
  ).toContainText("未保存草稿");
  await expect(
    dialog.getByTestId("session-permission-policy-fact"),
  ).toContainText("允许");
  await dialog.getByRole("tab", { name: "安全审查", exact: true }).click();
  await expect(dialog.getByText(/Deny 自动拒绝/)).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "审查模型", exact: true })
    .selectOption(JSON.stringify(["provider", "model-1", null]));
  await dialog.getByTestId("session-permission-save").click();
  await expect(dialog.getByRole("status")).toContainText(
    "会话权限已保存并生效",
  );
  expect(sent.expected_revision).toBe(7);
  expect(sent.review_model).toEqual({
    provider_id: "provider",
    model: "model-1",
  });
  expect(sent.overrides.slice(0, 2)).toEqual(opaque);
  expect(sent.overrides.at(-1)).toEqual({
    agent: "coding",
    mode: "plan",
    tool: { kind: "exact", value: "read" },
    action: "deny",
  });
});

test("permission conflict retains advanced draft and reload requires explicit confirmation", async ({
  page,
}) => {
  await nativeBackend(page);
  let gets = 0;
  await page.route("**/api/v1/sessions/s1/permission", async (route) => {
    if (route.request().method() === "PUT")
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "revision_conflict",
            message: "Permission revision changed",
          },
        },
      });
    gets++;
    return route.fulfill({ json: policy() });
  });
  await page.goto("/#session/s1");
  await page.getByTestId("composer-session-permissions").click();
  const dialog = page.getByTestId("session-permissions");
  await dialog
    .getByRole("button", { name: "高级权限 JSON", exact: true })
    .click();
  const editor = dialog.getByRole("textbox", { name: "高级权限 JSON" });
  const draft = {
    ...policy().config,
    review: false,
    review_model: {
      provider_id: "unavailable",
      model: "explicit",
      variant: "fast",
    },
  };
  await editor.fill(JSON.stringify(draft));
  await dialog.getByTestId("session-permission-save").click();
  await expect(dialog.getByRole("alert")).toContainText("草稿仍保留");
  await expect(editor).toHaveValue(JSON.stringify(draft));
  await dialog
    .getByRole("button", { name: "重新载入最新策略", exact: true })
    .click();
  expect(gets).toBe(1);
  await dialog
    .getByRole("button", { name: "确认重新载入并替换草稿", exact: true })
    .click();
  await expect.poll(() => gets).toBe(2);
});
