import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("complete execution readers fence sources, preserve Unicode, and stop at captured output end", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  const result = await page.evaluate(async () => {
    const {
      readCompleteExecutionContent,
      readCompleteRetainedOutput,
      executionElapsed,
    } = await import("/src/features/executionContent.ts");
    const identity = { session_id: "s1", execution_id: 23, call_id: "call23" };
    const hash = "a".repeat(64);
    const contentCalls: number[] = [];
    const text = await readCompleteExecutionContent(
      async (cursor) => {
        contentCalls.push(cursor);
        return {
          ...identity,
          field: "arguments",
          content: cursor ? "🙂" : "中",
          cursor,
          next_cursor: cursor ? 7 : 3,
          end_cursor: 7,
          revision: 4 + cursor,
          available: true,
          source_hash: hash,
        };
      },
      identity,
      "arguments",
    );
    let changed = false;
    try {
      await readCompleteExecutionContent(
        async (cursor) => ({
          ...identity,
          field: "result",
          content: "a",
          cursor,
          next_cursor: cursor + 1,
          end_cursor: 2,
          revision: 1,
          available: true,
          source_hash: cursor ? "b".repeat(64) : hash,
        }),
        identity,
        "result",
      );
    } catch {
      changed = true;
    }
    const outputCalls: number[] = [];
    const output = await readCompleteRetainedOutput(async (cursor) => {
      outputCalls.push(cursor);
      return {
        execution_id: 23,
        cursor,
        next_cursor: cursor ? 7 : 3,
        end_cursor: cursor ? 7 : 6,
        start_cursor: 0,
        closed: false,

        revision: 1,
        chunks: [
          {
            cursor,
            next_cursor: cursor ? 7 : 3,
            channel: "stdout",
            content: cursor ? "defg" : "abc",
          },
        ],
      };
    }, identity);
    let noProgress = false;
    try {
      await readCompleteRetainedOutput(
        async () => ({
          execution_id: 23,
          cursor: 0,
          next_cursor: 0,
          end_cursor: 1,
          start_cursor: 0,
          closed: false,

          revision: 1,
          chunks: [],
        }),
        identity,
      );
    } catch {
      noProgress = true;
    }
    const base = {
      ...identity,
      capabilities: { input: false },
      agent: "a",
      mode: null,
      tool: "read",
    } as const;
    return {
      text,
      contentCalls,
      changed,
      output,
      outputCalls,
      noProgress,
      unknown: executionElapsed({ ...base, status: "running" }, 1000),
      terminalUnknown: executionElapsed(
        { ...base, status: "succeeded", started_at_unix_ms: 100 },
        1000,
      ),
      cleanupFixed: executionElapsed(
        { ...base, status: "running", started_at_unix_ms: 100, elapsed_ms: 12 },
        1000,
      ),
      running: executionElapsed(
        { ...base, status: "running", started_at_unix_ms: 100 },
        1000,
      ),
    };
  });
  expect(result.text).toEqual({ available: true, content: "中🙂" });
  expect(result.contentCalls).toEqual([0, 3]);
  expect(result.changed).toBe(true);
  expect(result.outputCalls).toEqual([0, 3]);
  expect(result.output.chunks).toEqual([
    { channel: "stdout", content: "abcdef", cursor: 0, next_cursor: 6 },
  ]);
  expect(result.output.endCursor).toBe(6);
  expect(result.noProgress).toBe(true);
  expect(result.unknown).toBeNull();
  expect(result.terminalUnknown).toBeNull();
  expect(result.cleanupFixed).toBe(12);
  expect(result.running).toBe(900);
});

test("header includes terminal retained tasks and complete peek is a nonconsuming bounded read", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  backend.snapshot().executions = [
    {
      execution_id: 23,
      session_id: "s1",
      call_id: "c23",
      tool: "retained-reader",
      agent: "universal",
      mode: null,
      status: "succeeded",
      capabilities: { input: false },
      elapsed_ms: 42,
      output_availability: "retained",
      arguments_available: true,
      result_available: true,
      output: {
        channels: ["stdout"],
        bytes: 6,

        start_cursor: 0,
        end_cursor: 6,
        closed: true,
      },
    },
  ];
  const reads: string[] = [];
  await page.route(
    "**/api/v1/sessions/s1/executions/23/content?*",
    async (route) => {
      const url = new URL(route.request().url());
      const field = url.searchParams.get("field");
      const cursor = Number(url.searchParams.get("cursor"));
      reads.push(
        `${route.request().method()}:${field}:${cursor}:${url.searchParams.get("max_bytes")}`,
      );
      const source = field === "arguments" ? "abcdef" : "result";
      const next = Math.min(cursor + 3, source.length);
      await route.fulfill({
        json: {
          session_id: "s1",
          execution_id: 23,
          call_id: "c23",
          field,
          content: source.slice(cursor, next),
          cursor,
          next_cursor: next,
          end_cursor: source.length,
          revision: 1,
          available: true,
          source_hash: "a".repeat(64),
        },
      });
    },
  );
  backend.handleSessionCommand((command, sessionId) => {
    if (command.method !== "executions.read") return;
    expect(sessionId).toBe("s1");
    expect(command).not.toHaveProperty("session_id");
    expect(command.params.execution_id).toBe(23);
    const { cursor, max_bytes } = command.params;
    reads.push(`${command.method}:output:${cursor}:${max_bytes}`);
    return {
      data: {
        execution_id: 23,
        cursor,
        next_cursor: cursor + 3,
        end_cursor: 6,
        start_cursor: 0,
        closed: true,

        revision: 1,
        chunks: [
          {
            channel: "stdout",
            content: cursor ? "def" : "abc",
            cursor,
            next_cursor: cursor + 3,
          },
        ],
      },
    };
  });
  await page.goto("/#session/s1");
  await page.getByTestId("header-executions").click();
  const entry = page.getByTestId("header-execution-23");
  await expect(entry).toContainText("已完成");
  await expect(entry).toContainText("0s");
  expect(reads).toEqual([]);
  // The reviewed baseline makes the whole entry the native peek button.
  await expect(entry).toHaveRole("button");
  await expect(entry).toHaveAccessibleName("retained-reader · 执行 #23");
  await entry.click();
  const peek = page.getByTestId("execution-peek");
  await expect(peek).toBeVisible();
  await expect(peek.getByTestId("execution-peek-duration")).toHaveText("42 ms");
  await expect(peek.getByTestId("execution-peek-output")).toContainText(
    "abcdef",
  );
  await expect(peek).toContainText("result");
  expect(reads.filter((read) => read.includes(":output:"))).toEqual([
    "executions.read:output:0:65536",
    "executions.read:output:3:65536",
  ]);
  expect(reads.filter((read) => read.includes(":arguments:"))).toEqual([
    "GET:arguments:0:65536",
    "GET:arguments:3:65536",
  ]);
  expect(
    backend.commands.some((command: any) =>
      ["turn.submit", "turn.queue", "job", "executions.cancel"].includes(
        command.method,
      ),
    ),
  ).toBe(false);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
    }
  }
  await page.keyboard.press("Escape");
  await expect(peek).toHaveCount(0);
});

test("ring inspection clamps lost prefixes, preserves UTF-8 channel order and rejects invalid continuity", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/#session/s1");
  const result = await page.evaluate(async () => {
    const { readCompleteRetainedOutput, validateOutputPage } =
      await import("/src/features/executionContent.ts");
    const identity = { session_id: "s1", execution_id: 23, call_id: "c23" };
    const calls: number[] = [];
    const output = await readCompleteRetainedOutput(async (requested) => {
      calls.push(requested);
      return requested === 0
        ? {
            execution_id: 23,
            start_cursor: 3,
            cursor: 3,
            next_cursor: 6,
            end_cursor: 14,
            closed: false,
            revision: 1,
            chunks: [
              { channel: "stdout", content: "中", cursor: 3, next_cursor: 6 },
            ],
          }
        : {
            execution_id: 23,
            start_cursor: 10,
            cursor: 10,
            next_cursor: 18,
            end_cursor: 18,
            closed: false,
            revision: 2,
            chunks: [
              {
                channel: "stderr",
                content: "🙂tail",
                cursor: 10,
                next_cursor: 18,
              },
            ],
          };
    }, identity);
    const invalid = [
      { cursor: 0, next_cursor: 1, start_cursor: 2, end_cursor: 3, chunks: [] },
      {
        cursor: 0,
        next_cursor: 2,
        start_cursor: 0,
        end_cursor: 2,
        chunks: [{ channel: null, content: "中", cursor: 0, next_cursor: 2 }],
      },
      {
        cursor: 0,
        next_cursor: 2,
        start_cursor: 0,
        end_cursor: 2,
        chunks: [{ channel: null, content: "a", cursor: 1, next_cursor: 2 }],
      },
      { cursor: 0, next_cursor: 0, start_cursor: 0, end_cursor: 3, chunks: [] },
    ].map((value) => {
      try {
        validateOutputPage(
          { execution_id: 23, closed: true, revision: 1, ...value },
          23,
          0,
        );
        return false;
      } catch {
        return true;
      }
    });
    return { calls, output, invalid };
  });
  expect(result.calls).toEqual([0, 6]);
  expect(result.output).toMatchObject({
    startCursor: 10,
    endCursor: 14,
    chunks: [
      { channel: "stdout", content: "中", cursor: 3, next_cursor: 6 },
      { channel: "stderr", content: "🙂", cursor: 10, next_cursor: 14 },
    ],
  });
  expect(result.invalid).toEqual([true, true, true, true]);
});
