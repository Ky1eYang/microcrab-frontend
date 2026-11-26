import { expect, test } from "@playwright/test";
import {
  DEFAULT_TOOL_IMAGE_BYTES,
  LIMIT_FIELDS,
  normalizeSettingsSnapshot,
  validateSettingsOverrides,
  validateSettingsSnapshot,
} from "../src/client/settings";
import { applySnapshot, createTranscript } from "../src/client/projector";
import { nativeBackend, nativeSnapshot } from "./native-fixture";
import type { NativeMessage } from "../src/client/types";

function settings(imageBytes?: number, constraint?: number) {
  const limits = Object.fromEntries(
    LIMIT_FIELDS.filter((field) => field !== "max_tool_image_bytes").map(
      (field) => [field, 1048576],
    ),
  );
  const effective = {
    limits: {
      ...limits,
      ...(imageBytes === undefined ? {} : { max_tool_image_bytes: imageBytes }),
    },
  };
  return {
    revision: 1,
    overrides:
      imageBytes === undefined
        ? {}
        : { limits: { max_tool_image_bytes: imageBytes } },
    effective,
    desired_effective: structuredClone(effective),
    constraints: {
      limits: {
        ...limits,
        ...(constraint === undefined
          ? {}
          : { max_tool_image_bytes: constraint }),
      },
    },
    sources: {},
    applied_revision: 1,
    application: "defaults_saved",
    reason: null,
  };
}
function toolMessages(sessionId = "s1"): NativeMessage[] {
  return [
    {
      id: "tool-call-message",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [
        {
          id: "image-call",
          name: "read_image",
          arguments: { path: "image.png" },
        },
      ],
    },
    {
      id: "tool-result-message",
      role: "tool",
      call_id: "image-call",
      tool_name: "read_image",
      text: '{"caption":"Tool image output"}',
      parts: [
        { type: "text", text: "Tool image output" },
        {
          type: "image",
          media_type: "image/png",
          source: {
            type: "url",
            url: `/api/v1/sessions/${sessionId}/images/tool-result-message/1`,
          },
        },
      ],
      tool_calls: [],
    },
  ];
}

test("image limit accepts nondefault values and normalizes only omitted legacy resolved views", () => {
  const legacy = settings();
  const before = JSON.stringify(legacy);
  expect(() => validateSettingsSnapshot(legacy)).not.toThrow();
  const view = normalizeSettingsSnapshot(legacy);
  expect(view.effective.limits.max_tool_image_bytes).toBe(
    DEFAULT_TOOL_IMAGE_BYTES,
  );
  expect(view.desired_effective.limits.max_tool_image_bytes).toBe(
    DEFAULT_TOOL_IMAGE_BYTES,
  );
  expect(view.constraints.limits.max_tool_image_bytes).toBe(
    DEFAULT_TOOL_IMAGE_BYTES,
  );
  expect(view.overrides).toEqual({});
  expect(JSON.stringify(legacy)).toBe(before);
  const custom = normalizeSettingsSnapshot(settings(512 * 1024, 768 * 1024));
  expect(custom.effective.limits.max_tool_image_bytes).toBe(512 * 1024);
  expect(custom.constraints.limits.max_tool_image_bytes).toBe(768 * 1024);
  expect(() =>
    validateSettingsOverrides({ limits: { max_tool_image_bytes: 256 * 1024 } }),
  ).not.toThrow();
  for (const value of [null, -1, 0, 0.5, "524288", Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      normalizeSettingsSnapshot(settings(value as number, 1048576)),
    ).toThrow(/max_tool_image_bytes/);
});

test("tool images survive native call-result merging with exact original canonical part index", () => {
  const transcript = applySnapshot(
    { ...nativeSnapshot, messages: toolMessages() },
    createTranscript(),
    "http://localhost/",
  );
  expect(transcript.blocks).toHaveLength(1);
  expect(transcript.blocks[0].tool.input).toEqual({ path: "image.png" });
  expect(transcript.blocks[0].payload.text).toBe(
    '{"caption":"Tool image output"}',
  );
  expect(transcript.blocks[0].payload.attachments).toMatchObject([
    {
      partId: "image-1",
      url: "http://localhost/api/v1/sessions/s1/images/tool-result-message/1",
      sourceOmitted: false,
    },
  ]);
  const child = applySnapshot(
    {
      ...nativeSnapshot,
      session: { ...nativeSnapshot.session, id: "child" },
      messages: toolMessages("child"),
    },
    createTranscript(),
    "http://localhost/",
  );
  expect(child.blocks[0].payload.attachments[0].url).toBe(
    "http://localhost/api/v1/sessions/child/images/tool-result-message/1",
  );
});

test("expanded tool output retains raw text and canonical image rail, empty old tools remain unchanged", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().messages = [
    ...toolMessages(),
    {
      id: "empty-call",
      role: "assistant",
      text: null,
      parts: [],
      tool_calls: [{ id: "empty", name: "empty_tool", arguments: {} }],
    },
    {
      id: "empty-result",
      role: "tool",
      call_id: "empty",
      tool_name: "empty_tool",
      text: "",
      parts: [],
      tool_calls: [],
    },
  ];
  const imageRequests: string[] = [];
  await page.route(
    "**/api/v1/sessions/s1/images/tool-result-message/1",
    (route) => {
      imageRequests.push(route.request().url());
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    },
  );
  await page.goto("/#session/s1");
  const group = page.locator(".tool-accordion-group-header");
  await group.first().click();
  await page.getByTestId("tool-row").filter({ hasText: "read_image" }).click();
  await expect(page.getByTestId("tool-payload-output").first()).toContainText(
    /"caption":\s*"Tool image output"/,
  );
  await expect(page.getByTestId("image-preview-trigger")).toHaveCount(1);
  await expect.poll(() => imageRequests.length).toBe(1);
  expect(imageRequests[0]).toContain(
    "/sessions/s1/images/tool-result-message/1",
  );
  await page.getByTestId("tool-row").filter({ hasText: "empty_tool" }).click();
  await expect(page.getByTestId("image-preview-trigger")).toHaveCount(0);
  await page.getByTestId("tool-row").filter({ hasText: "read_image" }).click();
  await expect(page.getByTestId("image-preview-trigger")).toHaveCount(1);
  expect(await page.locator("body").innerText()).not.toContain("data:image");
});

test("child tool images retain the existing exact child resource path under read-only inspection", async ({
  page,
}) => {
  await nativeBackend(page, {
    children: [
      {
        id: "child-image",
        parent_session_id: "s1",
        name: "image child",
        status: "completed",
        availability: "persisted",
        messages: toolMessages("child-image"),
        next_cursor: null,
        messages_truncated: false,
        receipt: null,
        usage: null,
        executions: [],
        history: null,
      },
    ],
  });
  const requests: string[] = [];
  await page.route(
    "**/api/v1/sessions/child-image/images/tool-result-message/1",
    (route) => {
      requests.push(route.request().url());
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    },
  );
  await page.goto("/#session/s1");
  await page.getByTestId("header-subagents").click();
  await page
    .locator(".subagent-menu-item")
    .getByRole("button", { name: "详情", exact: true })
    .click();
  const child = page.getByTestId("child-content-view");
  await child.locator(".tool-accordion-group-header").click();
  await child.getByTestId("tool-row").click();
  await expect(child.getByTestId("image-preview-trigger")).toHaveCount(1);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toContain(
    "/sessions/child-image/images/tool-result-message/1",
  );
  await expect(child.getByTestId("child-input")).toBeDisabled();
  await expect(child.getByTestId("undo-user-block")).toHaveCount(0);
});

for (const legacy of [false, true]) {
  test(`${legacy ? "legacy omitted" : "nondefault"} image limit displays and saves independently of tool text limit`, async ({
    page,
  }) => {
    await nativeBackend(page);
    let snapshot = settings(
      legacy ? undefined : 512 * 1024,
      legacy ? undefined : 768 * 1024,
    );
    const puts: any[] = [];
    await page.route("**/api/v1/settings", (route) => {
      if (route.request().method() === "PUT") {
        puts.push(route.request().postDataJSON());
        snapshot = {
          ...settings(
            puts.at(-1).overrides.limits.max_tool_image_bytes,
            legacy ? undefined : 768 * 1024,
          ),
          overrides: puts.at(-1).overrides,
        };
      }
      return route.fulfill({ json: snapshot });
    });
    await page.goto("/#session/s1");
    await page.locator('.shell [data-testid="nav-dashboard"]').first().click();
    await page.getByTestId("dashboard-nav-settings").click();
    await page.getByTestId("console-settings-tab-defaults").click();
    const input = page.getByTestId("limit-max_tool_image_bytes");
    await expect(input).toHaveAttribute(
      "placeholder",
      String(legacy ? 1048576 : 524288),
    );
    await expect(input).toHaveAttribute(
      "max",
      String(legacy ? 1048576 : 786432),
    );
    await expect(
      page.getByTestId("limit-max_tool_output_bytes"),
    ).toHaveAttribute("placeholder", "1048576");
    await input.fill("262144");
    await page.getByTestId("settings-save").click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0].overrides.limits.max_tool_image_bytes).toBe(262144);
    expect(puts[0].overrides.limits).not.toHaveProperty(
      "max_tool_output_bytes",
    );
    await expect(input).toHaveValue("262144");
  });
}
