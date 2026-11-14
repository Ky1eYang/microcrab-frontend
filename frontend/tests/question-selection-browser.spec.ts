import { test, expect, type Locator } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { CLIENT_TOOL_DEFINITIONS } from "../src/client/client-tools";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";

function binding(multiple = false, observer = false): ClientBinding {
  const call: ClientInvocation = {
    invocation_id: "selection-question",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "selection-call",
    tool: "ask_user_question",
    arguments: {
      blocking_mode: "deferred",
      questions: [
        {
          id: "q",
          question: "请选择实施方案",
          multiple,
          options: [
            {
              id: "a",
              label: "方案甲",
              description: "保留用户内容",
              recommended: true,
            },
            { id: "b", label: "方案乙" },
          ],
        },
      ],
    },
    epoch: 0,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "frozen",
    status: "pending",
    created_at_ms: 1,
    deadline_ms: 0,
    interaction: true,
    blocking_mode: "deferred",
    prepared: false,
  };
  return {
    role: observer ? "observer" : "executor",
    lease_id: "lease",
    catalog_digest: "frozen",
    definitions: CLIENT_TOOL_DEFINITIONS,
    pending: [call],
    calls: [call],
  };
}

async function expectSelection(option: Locator, selected: boolean) {
  await expect(option).toHaveAttribute("aria-pressed", String(selected));
  await expect(option).toHaveAttribute("data-selected", String(selected));
  const indicator = option.locator(".question-option-indicator");
  await expect(indicator).toHaveAttribute("aria-hidden", "true");
  await expect(indicator).toHaveText("✓");
  if (selected) {
    await expect(indicator).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");
  } else {
    await expect(indicator).toHaveCSS("color", "rgba(0, 0, 0, 0)");
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`question options show hover, keyboard focus and single selection in ${theme} theme`, async ({
    page,
  }) => {
    await nativeBackend(page, { clientTools: binding() });
    await page.goto("/#session/s1");
    const first = page.getByRole("button", {
      name: "方案甲 推荐 保留用户内容",
      exact: true,
    });
    const second = page.getByRole("button", { name: "方案乙", exact: true });
    await expect(first).toBeVisible({ timeout: 30000 });
    await page
      .locator("html")
      .evaluate((html, value) => html.setAttribute("data-theme", value), theme);
    await expectSelection(first, false);
    const background = await first.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await first.hover();
    await expect(first).not.toHaveCSS("background-color", background);
    await first.focus();
    await page.keyboard.press("Space");
    await expect(first).toBeFocused();
    await expect(first).toHaveCSS("outline-style", "solid");
    await expect(first).toHaveCSS("outline-width", "2px");
    await expectSelection(first, true);
    await second.click();
    await expectSelection(first, false);
    await expectSelection(second, true);
    await page
      .getByRole("textbox", { name: "请选择实施方案：自定义回答", exact: true })
      .fill("用户自定义回答");
    await expectSelection(second, false);
    await first.click();
    await expect(
      page.getByRole("textbox", {
        name: "请选择实施方案：自定义回答",
        exact: true,
      }),
    ).toHaveValue("");
    await expectSelection(first, true);
  });
}

test("multiple options retain independent checks and submit the selected option IDs", async ({
  page,
}) => {
  const backend = await nativeBackend(page, { clientTools: binding(true) });
  await page.goto("/#session/s1");
  const first = page.getByRole("button", {
    name: "方案甲 推荐 保留用户内容",
    exact: true,
  });
  const second = page.getByRole("button", { name: "方案乙", exact: true });
  await expect(first).toBeVisible({ timeout: 30000 });
  await first.click();
  await second.click();
  await expectSelection(first, true);
  await expectSelection(second, true);
  await first.click();
  await expectSelection(first, false);
  await expectSelection(second, true);
  await first.click();
  await page
    .getByRole("textbox", { name: "请选择实施方案：自定义回答", exact: true })
    .fill("补充说明");
  await expectSelection(first, true);
  await expectSelection(second, true);
  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect
    .poll(
      () =>
        backend.commands.find(
          (command) => command.method === "client_tools.result",
        )?.params.result,
    )
    .toEqual({
      dismissed: false,
      answers: [{ id: "q", option_ids: ["b", "a"], custom: "补充说明" }],
    });
  await expect(first).toHaveCount(0);
});

test("observer options remain disabled without interactive hover highlighting", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    clientTools: binding(false, true),
  });
  await page.goto("/#session/s1");
  const first = page.getByRole("button", {
    name: "方案甲 推荐 保留用户内容",
    exact: true,
  });
  await expect(first).toBeVisible({ timeout: 30000 });
  await expect(first).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "提交", exact: true }),
  ).toBeDisabled();
  await expectSelection(first, false);
  const background = await first.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await first.hover();
  await expect(first).toHaveCSS("background-color", background);
  expect(
    backend.commands.some(
      (command) => command.method === "client_tools.result",
    ),
  ).toBe(false);
});
