import { expect, test } from "@playwright/test";
import { nativeBackend, nativeSnapshot } from "./native-fixture";

test("Personal Content Library tab loads live user objects without mock banner and Markdown resolves ref: URIs", async ({
  page,
}) => {
  const refId = "ref_0123456789abcdef";
  const owner = "u1";

  const backend = await nativeBackend(page, { owner });
  backend.snapshot().messages = [
    {
      id: "msg-ref-test",
      role: "assistant",
      text: `Here is the diagram:\n\n![Architecture](ref:${refId})`,
      parts: [],
      tool_calls: [],
    },
  ];

  await page.route(`**/api/v1/users/${owner}/library/**`, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.endsWith("/objects") && req.method() === "GET") {
      return route.fulfill({
        json: {
          quota: {
            used_bytes: 1024,
            max_bytes: 256 * 1024 * 1024,
            object_count: 1,
            max_entries: 2048,
          },
          items: [
            {
              id: refId,
              title: "Architecture diagram",
              source_kind: "upload",
              source: { kind: "local_blob", origin: "upload" },
              media_type: "image/png",
              byte_length: 1024,
              revision: "1_abcd",
              read_only: false,
              created_at_unix_ms: 1700000000000,
              updated_at_unix_ms: 1700000000000,
              mounted_sessions: [],
              mounted_projects: [],
            },
          ],
        },
      });
    }
    if (url.pathname.endsWith("/content")) {
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7S8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
    }
    return route.fulfill({ json: {} });
  });

  await page.goto("/#session/s1");
  const img = page.locator(`img.markdown-ref-image[alt="Architecture"]`);
  await expect(img).toHaveAttribute(
    "src",
    new RegExp(`/api/v1/users/${owner}/library/objects/${refId}/content`),
  );

  await page.goto("/#dashboard");
  await page.getByRole("button", { name: "个人内容库" }).click();
  await expect(page.getByTestId("personal-library-view")).toBeVisible();
  await expect(page.getByTestId("dashboard-unsupported-notice")).toHaveCount(
    0,
  );
  await expect(page.getByTestId(`library-item-${refId}`)).toBeVisible();
  await expect(page.getByText("Architecture diagram")).toBeVisible();
});
