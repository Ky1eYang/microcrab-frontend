import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";

async function unauthenticated(page: Page) {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 401, json: { authenticated: false } }),
  );
}
async function identityProvider(page: Page) {
  let attempts = 0;
  await page.route("**/api/auth/login", (route) => {
    attempts++;
    return route.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture identity provider</h1>",
    });
  });
  return () => attempts;
}

for (const code of [
  "access_denied",
  "server_error",
  "unknown-private-code",
  "",
]) {
  test(`dedicated login owns callback error ${code || "empty"} and manual retry`, async ({
    page,
  }) => {
    await unauthenticated(page);
    const attempts = await identityProvider(page);
    await page.goto(
      `/?auth_error=${code}&error_description=secret-provider-detail`,
    );
    await expect(page).toHaveURL(/\/login\?auth_error=/);
    await expect(page.getByTestId("auth-login-page")).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      "secret-provider-detail",
    );
    await expect(page.locator(".shell")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(attempts()).toBe(0);
    await page.getByTestId("auth-login-submit").click();
    await expect.poll(attempts).toBe(1);
  });
}

test("back and reload keep the dedicated login manual after one automatic attempt", async ({
  page,
}) => {
  await unauthenticated(page);
  const attempts = await identityProvider(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  expect(attempts()).toBe(1);
  await page.getByTestId("auth-login-submit").click();
  await expect.poll(attempts).toBe(2);
});

test("unauthenticated IdP bounce to root stops at dedicated login", async ({
  page,
}) => {
  await unauthenticated(page);
  let attempts = 0;
  await page.route("**/api/auth/login", (route) => {
    attempts++;
    return route.fulfill({ status: 302, headers: { location: "/" } });
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  expect(attempts).toBe(1);
});

for (const failure of ["network", "server"]) {
  test(`${failure} probe failure stays on login and retry probes before OAuth`, async ({
    page,
  }) => {
    let unavailable = true;
    await page.route("**/api/auth/session", (route) =>
      unavailable
        ? failure === "network"
          ? route.abort("failed")
          : route.fulfill({ status: 503, body: "private-body" })
        : route.fulfill({ status: 401, json: {} }),
    );
    const attempts = await identityProvider(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private-body");
    expect(attempts()).toBe(0);
    unavailable = false;
    await page.getByTestId("auth-login-submit").click();
    await expect.poll(attempts).toBe(1);
  });
}

test("blocked storage leaves login usable without automatic redirect loops", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    }),
  );
  await unauthenticated(page);
  const attempts = await identityProvider(page);
  await page.goto("/");
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  expect(attempts()).toBe(0);
  await page.getByTestId("auth-login-submit").click();
  await expect.poll(attempts).toBe(1);
});

test("explicit signed-out arrival stays manual and retains localized login", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.locale", "en"),
  );
  await unauthenticated(page);
  const attempts = await identityProvider(page);
  await page.goto("/login?signed_out=1");
  await expect(page).toHaveTitle("Sign in to your workspace | microcrab");
  await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
  await expect(page.locator("input")).toHaveCount(0);
  expect(attempts()).toBe(0);
});

test("global socket expiry verifies cookie once and saves draft before login", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const attempts = await identityProvider(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await connectHostUI(page);
  await page
    .locator('[data-testid="composer"] textarea')
    .fill("socket expiry draft");
  await unauthenticated(page);
  await backend.sockets
    .at(-1)!
    .close({ code: 1000, reason: "authentication_lost" });
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  expect(attempts()).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("microcrab.auth-return.v1")!),
    ),
  ).toMatchObject({
    owner: "u1",
    route: "/#session/s1",
    composer: "socket expiry draft",
  });
});

test("selected socket unauthenticated refusal goes directly to dedicated login", async ({
  page,
}) => {
  await nativeBackend(page);
  const attempts = await identityProvider(page);
  await page.routeWebSocket("**/api/v1/sessions/s1/ws*", (socket) => {
    socket.send(
      JSON.stringify({
        v: 1,
        type: "error",
        error: { code: "unauthenticated", message: "Authentication required" },
      }),
    );
  });
  // Initial probe authenticates; after the authoritative socket refusal the
  // dedicated page observes expiry and owns the only OAuth attempt.
  let probes = 0;
  await page.route("**/api/auth/session", (route) => {
    probes++;
    return route.fulfill({
      json:
        probes === 1
          ? {
              authenticated: true,
              principal: {
                owner: "u1",
                subject: "sub1",
                display_name: "Test User",
                expires_at: 9999999999,
              },
            }
          : { authenticated: false },
    });
  });
  await page.goto("/#session/s1");
  await expect(
    page.getByRole("heading", { name: "Fixture identity provider" }),
  ).toBeVisible();
  expect(attempts()).toBe(1);
});

test("network loss with a valid browser session does not start authentication", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  const attempts = await identityProvider(page);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await backend.sockets
    .at(-1)!
    .close({ code: 1011, reason: "network interruption" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  expect(attempts()).toBe(0);
});

for (const scenario of ["login-page", "login-error", "login-checking"]) {
  for (const locale of ["zh-CN", "en"]) {
    for (const theme of ["light", "dark"]) {
      test(`dedicated ${scenario} ${locale} ${theme} fits mobile and desktop`, async ({
        page,
      }) => {
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(
            `/fixture/?scenario=${scenario}&theme=${theme}&locale=${locale}`,
          );
          await expect(page.getByTestId("auth-login-page")).toBeVisible();
          await expect(page.locator(".shell")).toHaveCount(0);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          if (scenario === "login-checking")
            await expect(page.getByTestId("auth-login-submit")).toBeDisabled();
          else
            await expect(page.getByTestId("auth-login-submit")).toBeEnabled();
          if (scenario === "login-error")
            await expect(page.getByRole("alert")).toBeVisible();
        }
      });
    }
  }
}
