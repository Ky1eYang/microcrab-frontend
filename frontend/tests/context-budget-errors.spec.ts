import { expect, test } from "@playwright/test";
import { failureText } from "../src/client/failure";
import { activeLocale, setActiveLocale } from "../src/i18n";
import type { NativeOperation } from "../src/client/types";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

function failed(error: unknown, retry = false): NativeOperation {
  return {
    version: 1,
    id: "budget-failure",
    session_id: "s1",
    owner: "u1",
    method: "turn.submit",
    payload_hash: "fixture",
    status: "failed",
    revision: 1,
    created_at_ms: 10,
    updated_at_ms: 11,
    result: {
      error,
      after_message_id: "m2",
      position: { epoch: 0, turn: 1, round: 2 },
      retry_ready: retry,
    },
  };
}
const reservation = {
  code: "limit",
  message: "Tool result reservation exceeds context budget",
  details: {
    reason: "tool_result_reservation",
    calls: 8,
    required_bytes: 3145728,
    budget_bytes: 2097152,
    pre_effect: true,
  },
};

for (const retry of [false, true]) {
  test(`snapshot local reservation uses exact evidence and server retry identity (${retry})`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page, { extraMethods: ["turn.retry"] });
    backend.snapshot().operations = [failed(reservation, retry)];
    Object.assign(backend.snapshot().session, {
      retry_ready: retry,
      retry_operation_id: retry ? "budget-failure" : null,
    });
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const check = async () => {
      const block = page.getByTestId("operation-failure");
      await expect(block).toContainText("工具结果预留超出上下文预算");
      await expect(block).toContainText("工具调用数：8");
      await expect(block).toContainText("所需：3.0 MiB（3145728 字节）");
      await expect(block).toContainText("预算：2.0 MiB（2097152 字节）");
      await expect(block).toContainText("该响应未执行工具。");
      await expect(block).not.toContainText("上游");
      await expect(block).not.toContainText("检查模型配置");
      await expect(page.getByTestId("retry-model-request")).toHaveCount(
        retry ? 1 : 0,
      );
    };
    await check();
    backend.publish(backend.snapshot());
    await check();
    await page.reload();
    await check();
    expect(
      backend.commands.filter((command) => command.method === "turn.retry"),
    ).toHaveLength(0);
  });
}

for (const preEffect of [undefined, false]) {
  test(`live local limit never infers tool effects or retry (${String(preEffect)})`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page, { extraMethods: ["turn.retry"] });
    await page.goto("/#session/s1");
    await connectHostUI(page);
    const details = {
      ...reservation.details,
      pre_effect: preEffect,
      path: "/private/DO_NOT_RENDER",
      secret: "SECRET_DO_NOT_RENDER",
      provider_body: "PRIVATE_BODY",
    };
    const operation = failed({ ...reservation, details }, true);
    // Only a receipt claims retry_ready; the Session has supplied no retry identity.
    backend.event("turn", operation);
    const block = page.getByTestId("operation-failure");
    await expect(block).toContainText("工具结果预留超出上下文预算");
    await expect(block).not.toContainText("未执行工具");
    await expect(block).not.toContainText("DO_NOT_RENDER");
    await expect(block).not.toContainText("PRIVATE_BODY");
    await expect(block).not.toContainText("上游");
    await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
    backend.snapshot().operations = [operation];
    backend.publish(backend.snapshot());
    await expect(block).toHaveCount(1);
    await expect(block).toContainText("工具调用数：8");
  });
}

test("unknown local reason preserves server message without dumping details or unsafe numeric evidence", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().operations = [
    failed({
      code: "limit",
      message: "Bounded admission limit",
      details: {
        reason: "PRIVATE_UNKNOWN_REASON",
        required_bytes: Number.MAX_SAFE_INTEGER + 1,
        budget_bytes: -1,
        calls: "8 secret",
        path: "/private/config",
        secret: "DO_NOT_RENDER",
        pre_effect: true,
      },
    }),
  ];
  await page.goto("/#session/s1");
  const block = page.getByTestId("operation-failure");
  await expect(block).toHaveText("请求未能成功响应Bounded admission limit");
  await expect(block).not.toContainText("未执行工具");
  await expect(block).not.toContainText("上游");
  await expect(block).not.toContainText("DO_NOT_RENDER");
  await expect(block).not.toContainText("private");
});

test("model response timeout has its own localized category and preserves the actual message", () => {
  const previous = activeLocale();
  try {
    for (const locale of ["zh-CN", "en"] as const) {
      setActiveLocale(locale);
      expect(
        failureText({
          code: "provider_timeout",
          message: "Model request timed out",
        }),
      ).toBe(
        locale === "zh-CN"
          ? "模型请求等待超时：Model request timed out"
          : "Timed out waiting for the model response: Model request timed out",
      );
      for (const code of ["provider_error", "provider_status"])
        expect(failureText({ code, message: "HTTP 502" })).toBe(
          locale === "zh-CN"
            ? "上游模型调用失败：HTTP 502"
            : "Upstream model request failed: HTTP 502",
        );
    }
  } finally {
    setActiveLocale(previous);
  }
});

for (const code of [
  "provider",
  "provider_status",
  "provider_timeout",
  "transport",
]) {
  test(`provider failure retains provider wording (${code})`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    backend.snapshot().operations = [
      failed({ code, message: "Provider request unavailable" }),
    ];
    await page.goto("/#session/s1");
    await expect(page.getByTestId("operation-failure")).toContainText(
      code === "provider_timeout"
        ? "模型请求等待超时：Provider request unavailable"
        : "上游模型调用失败：Provider request unavailable",
    );
    await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
  });
}

test("structured admission rejection retains main draft and exact local reason without a model block", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    submitError: reservation,
    extraMethods: ["turn.retry"],
  });
  backend.snapshot().messages = [];
  await page.goto("/#session/s1");
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("Keep this draft after rejected admission");
  await page.getByTitle("发送 (Enter)", { exact: true }).click();
  const toast = page.locator('.toast-container[data-kind="error"]');
  await expect(toast).toContainText("工具结果预留超出上下文预算");
  await expect(toast).toContainText("3.0 MiB");
  await expect(toast).not.toContainText("上游");
  await expect(composer).toHaveValue(
    "Keep this draft after rejected admission",
  );
  await expect(page.getByTestId("operation-failure")).toHaveCount(0);
  await expect(page.getByTestId("retry-model-request")).toHaveCount(0);
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(1);
});

test("known category ignores invalid numeric fields and preserves zero facts", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().operations = [
    failed({
      code: "limit",
      message: "Input limit exceeded",
      details: {
        reason: "input_bytes",
        calls: 0,
        required_bytes: 1.5,
        budget_bytes: "secret budget",
        pre_effect: false,
      },
    }),
  ];
  await page.goto("/#session/s1");
  const block = page.getByTestId("operation-failure");
  await expect(block).toContainText("输入超出字节预算");
  await expect(block).toContainText("工具调用数：0");
  await expect(block).not.toContainText("MiB");
  await expect(block).not.toContainText("secret");
});
