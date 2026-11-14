import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

for (const rename of ["automatic", "manual"] as const) {
  test(`${rename} rename preserves session selection and subsequent input`, async ({
    page,
  }) => {
    const backend = await nativeBackend(page);
    await page.goto("/#session/s1");
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    await connectHostUI(page);

    await page.getByLabel("消息", { exact: true }).fill("first input");
    await page.getByTitle("发送 (Enter)").click();
    await expect
      .poll(
        () => backend.commands.filter((c) => c.method === "turn.queue").length,
      )
      .toBe(1);
    backend.finish("first canonical answer");
    backend.event("turn", { id: "first-operation", status: "completed" });
    await expect(
      page.getByText("first canonical answer", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();

    const before = structuredClone(backend.snapshot());
    const title = `${rename} renamed session`;
    if (rename === "automatic") {
      // Auto naming publishes the same canonical conversation with title/CAS changes.
      backend.snapshot().session = {
        ...backend.snapshot().session,
        title,
        revision: backend.snapshot().session.revision + 1,
      };
      backend.publish(backend.snapshot());
    } else {
      await page
        .locator('.session-item-row[data-active="true"] .session-item-title')
        .dblclick();
      const dialog = page.getByRole("dialog", {
        name: "重命名会话",
        exact: true,
      });
      await dialog.getByLabel("会话标题").fill(title);
      await dialog.getByRole("button", { name: "保存", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(
        backend.requests.filter(
          (r) => r.method === "PATCH" && r.path === "/api/v1/sessions/s1",
        ),
      ).toHaveLength(1);
    }

    await expect(page).toHaveURL(/#session\/s1$/);
    await expect(
      page.locator('.session-item-row[data-active="true"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('.session-item-row[data-active="true"] .session-item-title'),
    ).toHaveText(title);
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    await expect(
      page.getByText("first canonical answer", { exact: true }),
    ).toBeVisible();
    expect(backend.snapshot().session.id).toBe(before.session.id);
    expect(backend.snapshot().messages).toEqual(before.messages);

    await page
      .getByLabel("消息", { exact: true })
      .fill("second input after rename");
    await page.getByTitle("发送 (Enter)").click();
    await expect
      .poll(
        () => backend.commands.filter((c) => c.method === "turn.queue").length,
      )
      .toBe(2);
    const turns = backend.commands.filter((c) => c.method === "turn.queue");
    expect(turns.map((c) => c.sessionId)).toEqual(["s1", "s1"]);
    expect(turns.every((c) => !Object.hasOwn(c, "session_id"))).toBe(true);
    expect(turns[1].params.input.parts).toEqual([
      { type: "text", text: "second input after rename" },
    ]);
    expect(
      backend.requests.filter(
        (r) => r.method === "POST" && r.path === "/api/v1/sessions",
      ),
    ).toHaveLength(0);
    backend.finish("second canonical answer");
    backend.event("turn", { id: "second-operation", status: "completed" });
    await expect(
      page.getByText("second canonical answer", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/#session\/s1$/);
    await expect(
      page.locator('.session-item-row[data-active="true"] .session-item-title'),
    ).toHaveText(title);
    await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
  });
}
