import { expect, test, type Page } from "@playwright/test";
import { LIMIT_FIELDS, PROMPT_FIELDS } from "../src/client/settings";
import { nativeBackend } from "./native-fixture";

function snapshot(
  overrides: Record<string, unknown> = {},
  revision = 1,
  session = false,
) {
  const limits = Object.fromEntries(
    LIMIT_FIELDS.map((field) => [field, 1048576]),
  );
  const effective = {
    limits,
    review: true,
    initialization: "allow",
    auto_naming: true,
    system_template: "Inherited project template",
    client_prompt: "Inherited client instructions",
    ...overrides,
  };
  return {
    revision,
    overrides,
    effective,
    desired_effective: effective,
    sources: { system_template: "project", client_prompt: "user" },
    constraints: { limits },
    applied_revision: revision,
    application: session ? "applied" : "defaults_saved",
    reason: null,
  };
}
async function setup(
  page: Page,
  overrides: Record<string, unknown> = {},
  session = false,
) {
  const backend = await nativeBackend(page, { owner: "prompt-settings-owner" });
  let saved = snapshot(overrides, 1, session);
  const writes: any[] = [];
  await page.route(
    session ? "**/api/v1/sessions/s1/settings" : "**/api/v1/settings",
    async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        writes.push(body);
        saved = snapshot(body.overrides, saved.revision + 1, session);
      }
      await route.fulfill({ json: saved });
    },
  );
  await page.goto("/#session/s1");
  // Under 768px the account card lives in the header-opened drawer.
  const railMenu = page.getByTestId("header-open-rail");
  if (await railMenu.isVisible()) await railMenu.click();
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("button", {
      name: session ? "当前会话配置" : "会话默认设置",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("prompt-settings")).toBeVisible();
  return { writes, backend };
}

for (const width of [1440, 390])
  test(`prompt settings preserve sparse defaults and authored bytes at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const { writes, backend } = await setup(page, { compact_template: null });
    const settings = page.getByTestId("prompt-settings");
    await expect(settings).toContainText("只用于新建会话");
    await expect(settings.getByRole("combobox")).toHaveCount(6);
    await page.getByTestId("settings-save").click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].overrides).toEqual({});
    await page
      .getByTestId("prompt-mode-system_template")
      .selectOption("custom");
    const system = page.getByTestId("prompt-setting-system_template");
    const authored =
      "  {% if agent is defined %}\n{{ agent | json_encode }}\n{% endif %}\n{{ client_prompt }}\n  ";
    await system.getByRole("textbox").fill(authored);
    await expect(
      system
        .locator(".prompt-token-variable")
        .filter({ hasText: "agent" })
        .first(),
    ).toBeVisible();
    await expect(
      system
        .locator(".prompt-token-variable")
        .filter({ hasText: "client_prompt" }),
    ).toBeVisible();
    await page.getByTestId("prompt-mode-client_prompt").selectOption("custom");
    const literal = "  literal {{ agent }} {{ client_prompt }}\n\n";
    const client = page.getByTestId("prompt-setting-client_prompt");
    await client.getByRole("textbox").fill(literal);
    await expect(client.locator(".prompt-token-variable")).toHaveCount(0);
    await page.getByTestId("settings-save").click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].overrides).toEqual({
      system_template: authored,
      client_prompt: literal,
    });
    expect(
      backend.commands.some(
        (command) => command.method === "session.set_model",
      ),
    ).toBe(false);
    expect(
      await settings.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
  });

test("SYSTEM describes bounded grammar and flags unsupported statements, functions and nested loops", async ({
  page,
}) => {
  await setup(page);
  await page.getByTestId("prompt-mode-system_template").selectOption("custom");
  const system = page.getByTestId("prompt-setting-system_template");
  await expect(system).toContainText("有界 Tera 2 子集");
  await expect(system).toContainText("for rule in agent.rules");
  await expect(system).toContainText("for hint in agent.hints");
  await expect(system).toContainText("safe、length、default、json_encode");
  const editor = system.getByRole("textbox");
  await editor.fill(
    "{% if agent is defined %}{{ agent | json_encode }}{% endif %}\n{% for rule in agent.rules %}{{ rule }}{% endfor %}\n{% for hint in agent.hints %}{{ hint }}{% endfor %}",
  );
  await expect(system.locator(".prompt-token-invalid")).toHaveCount(0);
  await editor.fill(
    '{% set x = 1 %}\n{{ range(end=1000000) }}\n{% include "SYSTEM" %}\n{% macro x() %}\n{% for rule in agent.rules %}{% for hint in agent.hints %}{{ hint }}{% endfor %}{% endfor %}\n{% for x in client_prompt %}{{ x }}{% endfor %}',
  );
  await expect(system.locator(".prompt-token-invalid")).toHaveCount(6);
  await editor.fill(
    '{{ client_prompt | default(value="literal range()") }}\n{{ agent | json_encode(pretty=true) }}',
  );
  await expect(system.locator(".prompt-token-invalid")).toHaveCount(0);
  if (process.env.MICROCRAB_PROMPT_SCREENSHOT)
    await system.screenshot({ path: process.env.MICROCRAB_PROMPT_SCREENSHOT });
  await editor.fill(
    '{{ agent | replace(from="x", to="y") }}\n{% for x in agent.rules %}{{ x }}{% endfor %}',
  );
  await expect(system.locator(".prompt-token-invalid")).toHaveCount(2);
});

test("explicit baseline, disable and inherit stay distinct; helper invalid syntax is highlighted", async ({
  page,
}) => {
  const { writes } = await setup(page, {
    system_template: "custom",
    client_prompt: "custom",
  });
  await page.getByTestId("prompt-mode-system_template").selectOption("empty");
  await page.getByTestId("prompt-mode-client_prompt").selectOption("empty");
  await page.getByTestId("prompt-mode-compact_template").selectOption("custom");
  const helper = page.getByTestId("prompt-setting-compact_template");
  await helper
    .getByRole("textbox")
    .fill(
      "{{ user_input }} {{ user_input }} {{ agent }} {{ user_input | safe }} {% if agent %}",
    );
  await expect(helper.locator(".prompt-token-variable")).toHaveCount(2);
  await expect(helper.locator(".prompt-token-invalid")).toHaveCount(3);
  await page
    .getByTestId("prompt-mode-compact_template")
    .selectOption("inherit");
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].overrides).toEqual({
    system_template: "",
    client_prompt: "",
  });
  await page.getByTestId("prompt-mode-system_template").selectOption("inherit");
  await page.getByTestId("prompt-mode-client_prompt").selectOption("inherit");
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].overrides).toEqual({});
});

test("action review highlights user intent and applied mode separately from the operation", async ({
  page,
}) => {
  await setup(page);
  await page
    .getByTestId("prompt-mode-action_review_template")
    .selectOption("custom");
  const review = page.getByTestId("prompt-setting-action_review_template");
  await expect(review).toContainText("最近一条已接纳的真实用户文本");
  await expect(review).toContainText("发起会话中已生效的模式及其原文指令");
  const bindings = [
    "{{ tool }}",
    "{{ tool_name }}",
    "{{ tool_args }}",
    "{{ user_input }}",
    "{{ operation_kind }}",
    "{{ mode }}",
    "{{ mode_prompt }}",
  ];
  const unsupported = ["{{ permission_request }}", "{{ mode | safe }}"];
  await review.getByRole("textbox").fill([...bindings, ...unsupported].join("\n"));
  await expect(review.locator(".prompt-token-variable")).toHaveText(bindings);
  await expect(review.locator(".prompt-token-invalid")).toHaveText(unsupported);
});

test("prompt edits preserve authored CRLF bytes and Session admission omits inherited prompt fields", async ({
  page,
}) => {
  const authored = "  first\r\nsecond {{ agent }}\r\n  ";
  const { writes } = await setup(page, { client_prompt: authored });
  const editor = page
    .getByTestId("prompt-setting-client_prompt")
    .getByRole("textbox");
  await editor.press("Control+End");
  await editor.press("End");
  await editor.press("x");
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].overrides.client_prompt).toBe(authored + "x");
  const payload = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    store.state.connection = "ws";
    store.state.authSession = {
      authenticated: true,
      principal: { owner: "owner" },
    };
    store.state.draftWorkspace = { kind: "local", projectId: "P" };
    store.state.hostConnection = {
      projectId: "P",
      connected: true,
      state: "ready",
      catalogReady: true,
    };
    store.state.agents = [
      {
        name: "X",
        component: "component-X",
        modes: [{ name: "x", role: "main_agent" }],
      },
    ];
    store.state.draftAgent = "X";
    store.state.draftMode = "x";
    store.draftAgentExplicit = true;
    store.draftModeExplicit = true;
    store.state.composer = "create";
    store.state.projectSessionDefaults = {
      projectId: "P",
      effective: {
        agent: "X",
        mode: "x",
        system_template: "project SYSTEM",
        client_prompt: "project client",
        compact_template: "project compact",
      },
    };
    let created: any = null;
    store.call = async (method: string, params: any) => {
      if (method === "session.create") {
        created = params;
        throw Error("captured admission");
      }
    };
    await store.submit().catch(() => {});
    return created;
  });
  expect(payload).toMatchObject({ agent: "X", mode: "x", project_id: "P" });
  for (const field of PROMPT_FIELDS) expect(payload).not.toHaveProperty(field);
});

test("Session prompt fields are frozen and excluded from ordinary Session saves", async ({
  page,
}) => {
  const frozen = Object.fromEntries(
    PROMPT_FIELDS.map((field) => [field, `frozen ${field}`]),
  );
  const { writes } = await setup(page, { ...frozen, review: true }, true);
  await expect(page.getByTestId("prompt-settings")).toContainText(
    "已在创建时冻结",
  );
  await expect(
    page.getByTestId("prompt-settings").getByRole("combobox"),
  ).toHaveCount(0);
  await page.getByTestId("settings-save").click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].overrides).toEqual({ review: true });
});
