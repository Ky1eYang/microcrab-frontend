import { test, expect, type Route } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("same-epoch history travel invalidates cached and pending trajectory audit evidence", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const snapshot = backend.snapshot();
  snapshot.history = {
    session_id: "s1",
    checkpoint_id: "checkpoint-a",
    epoch: 7,
  };
  snapshot.messages = [
    {
      id: "shared-user",
      role: "user",
      text: "Shared input",
      parts: [],
      tool_calls: [],
      position: { epoch: 7, turn: 1, round: 0 },
    },
  ];
  let branch = "a";
  let hold = false;
  const pending: { route: Route; branch: string; internal: boolean }[] = [];
  const response = (selected: string, internal: boolean) => ({
    status: "available",
    committed_sequence: 10,
    incomplete_tail: false,
    timeline: [
      {
        request_hash: `request-${selected}`,
        call_id: `call-${selected}`,
        sequence: 1,
        epoch: 7,
        turn: 1,
        round: 1,
        completion: "succeeded",
      },
    ],
    attempts: [
      {
        request_hash: `request-${selected}`,
        call_id: `call-${selected}`,
        sequence: 1,
        epoch: 7,
        turn: 1,
        round: 1,
        status: "available",
        completion: "succeeded",
        history_head: `checkpoint-${selected}`,
        ...(internal
          ? {
              subagent: `helper-${selected}`,
              response: `helper-body-${selected}`,
            }
          : { delta: `selected-diff-${selected}` }),
      },
    ],
  });
  await page.route("**/api/v1/sessions/s1/audit/requests", (route) => {
    const internal =
      route.request().postDataJSON().internal_assistants === true;
    if (hold) {
      pending.push({ route, branch, internal });
      return;
    }
    return route.fulfill({ json: response(branch, internal) });
  });
  await page.goto("/#session/s1");
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const helpers = page.locator(
    '[data-testid="trajectory-entry"][data-kind="internal-assistant"]',
  );
  await expect(helpers).toContainText("helper-a");
  await page
    .locator('[data-testid="trajectory-entry"][data-kind="model-request"]')
    .click();
  await page.getByRole("tab", { name: "请求增量", exact: true }).click();
  const details = page.getByTestId("request-audit-diff");
  await expect(details).toContainText("selected-diff-a");

  // Both effects now have an old-branch request in flight, as well as cached data.
  hold = true;
  backend.event("audit.available", {});
  await expect
    .poll(() => pending.filter((item) => item.branch === "a").length)
    .toBe(2);
  branch = "b";
  snapshot.history = {
    session_id: "s1",
    checkpoint_id: "checkpoint-b",
    epoch: 7,
  };
  snapshot.session.revision++;
  backend.publish(snapshot);
  await expect
    .poll(() => pending.filter((item) => item.branch === "b").length)
    .toBe(2);
  await expect(helpers).toHaveCount(0);
  await expect(details).not.toContainText("selected-diff-a");

  // Late replies for the previous cursor must not repopulate the new view.
  await Promise.all(
    pending
      .filter((item) => item.branch === "a")
      .map((item) =>
        item.route.fulfill({ json: response(item.branch, item.internal) }),
      ),
  );
  await expect(helpers).toHaveCount(0);
  await expect(details).not.toContainText("selected-diff-a");
  await Promise.all(
    pending
      .filter((item) => item.branch === "b")
      .map((item) =>
        item.route.fulfill({ json: response(item.branch, item.internal) }),
      ),
  );
  await expect(helpers).toContainText("helper-b");
  await expect(details).toContainText("selected-diff-b");
  await expect(details).not.toContainText("selected-diff-a");
});
