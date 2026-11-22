import { createServer, type ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page) {
  await page.goto("/tests/fixtures/plugin-network.html");
}

test("new HTTP methods require a native exact-endpoint opt-in without widening legacy grants", async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts",
      resourcesPath = "/src/plugins/resources.ts";
    const [{ PluginRegistry }, { PluginResources }] = await Promise.all([
      import(registryPath),
      import(resourcesPath),
    ]);
    const id = "any.plugin",
      owner = crypto.randomUUID();
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    }) as any;
    const resources = new PluginResources(
      location.origin,
      owner,
      id,
      "a".repeat(64),
    );
    const surface = { surface_id: "settings", target: "setting-page" };
    registry.plugins.set(id, {
      manifest: { name: "Arbitrary plugin" },
      imports: ["microcrab:client-plugin/resources@0.4.0"],
    });
    const instance = {
      resources,
      generation: 1,
      surfaceSequence: 1,
      surfaces: new Map([
        [
          surface.surface_id,
          { descriptor: surface, visible: true, revision: 1 },
        ],
      ]),
      effectIds: new Set(),
      controllers: new Map(),
      trees: new Map(),
      network: { retireStale() {} },
    };
    registry.live.set(id, instance);
    const config = {
      id: "resource",
      endpoint: "https://example.test/full?scope=one",
      authorization: "Bearer private-token",
      enabled: true,
    };
    const legacy = resources.configure(config, true)[0];
    const completions: any[] = [];
    registry.completion = (...args: any[]) =>
      completions.push({ ok: args[3], value: args[4], error: args[5] });
    const base = registry.context(1, surface);
    const payload = { ...config, methods: ["GET", "POST", "PATCH"] };
    const start = (requestId: number, action: boolean) =>
      registry.effect(
        id,
        instance,
        { kind: "resource-configure", request_id: requestId, payload },
        { ...base, user_action: action },
      );
    await start(1, false);
    (window as any).grantFixture = {
      start,
      resources,
      id,
      owner,
      PluginResources,
      config,
      completions,
      legacy,
      hide: () => registry.setSurfaceVisible(id, surface, false),
    };
  });
  const start = (requestId: number) =>
    page.evaluate((requestId) => {
      void (window as any).grantFixture.start(requestId, true);
    }, requestId);
  const dialog = page.getByRole("dialog");
  await start(2);
  await expect(dialog).toContainText("GET, POST, PATCH");
  await expect(dialog).toContainText("https://example.test/full?scope=one");
  await expect(dialog).not.toContainText("private-token");
  await dialog.getByRole("button", { name: /Do not allow|不允许/ }).click();
  await start(3);
  const accept = dialog.getByRole("button", { name: /Allow access|允许访问/ });
  await accept.evaluate((button: HTMLButtonElement) => button.click());
  await expect(dialog).toBeVisible();
  await accept.click();
  await expect(dialog).toBeHidden();
  const pin = await page.evaluate(
    () => (window as any).grantFixture.resources.list()[0].config_pin,
  );
  await start(4);
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).grantFixture.hide());
  await expect(dialog).toBeHidden();
  const actual = await page.evaluate(() => {
    const {
      resources,
      id,
      owner,
      PluginResources,
      config,
      completions,
      legacy,
    } = (window as any).grantFixture;
    const [grant] = resources.list();
    const request = { resource: grant.id, config_pin: grant.config_pin };
    function deny(fields: object) {
      try {
        resources.network({ ...request, ...fields });
        return false;
      } catch {
        return true;
      }
    }
    let invalidMethods = 0;
    for (const methods of [
      [],
      ["get"],
      ["GET", "GET"],
      ["CONNECT"],
      "GET",
      null,
    ]) {
      try {
        resources.configure({ ...config, methods }, true, () => true);
      } catch {
        invalidMethods++;
      }
    }
    const allowed = resources.network({ ...request, method: "GET" });
    const legacyDefault = resources.network(request).method;
    const mismatches = [
      deny({ method: "PUT" }),
      deny({ method: "GET", url: "https://example.test/full?scope=two" }),
      deny({ method: "GET", url: "https://elsewhere.test/full?scope=one" }),
      deny({ config_pin: legacy.config_pin }),
    ];
    PluginResources.reset(location.origin, owner, id);
    resources.close();
    return {
      legacyMethods: legacy.methods,
      completions,
      grant,
      invalidMethods,
      legacyDefault,
      mismatches,
      allowed: allowed.method,
    };
  });
  expect(actual.legacyMethods).toEqual(["POST"]);
  expect(actual.completions.map((r: any) => r.ok)).toEqual([
    false,
    false,
    true,
  ]);
  expect(JSON.stringify(actual)).not.toContain("private-token");
  expect(actual.grant.config_pin).toBe(pin);
  expect(actual.grant.methods).toEqual(["GET", "POST", "PATCH"]);
  expect(actual.invalidMethods).toBe(6);
  expect(actual.legacyDefault).toBe("POST");
  expect(actual.allowed).toBe("GET");
  expect(actual.mismatches).toEqual([true, true, true, true]);
});

test("real fetch streams authorized frames through CORS, omits login cookies, and rejects redirects", async ({
  page,
  context,
}) => {
  await fixture(page);
  const origin = new URL(page.url()).origin;
  await context.addCookies([
    { name: "login", value: "ambient-login", url: origin },
  ]);
  let stream: ServerResponse | undefined;
  let redirectHits = 0;
  const diagnostics: unknown[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  page.on("requestfailed", (request) =>
    diagnostics.push([request.url(), request.failure()]),
  );
  const requests: {
    url?: string;
    auth?: string;
    cookie?: string;
    accept?: string;
    referrer?: string;
  }[] = [];
  const server = createServer((req, response) => {
    if (req.url !== "/nocors")
      response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, x-correlation",
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "authorization, x-reflection",
    );
    if (req.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      accept: req.headers.accept,
      referrer: req.headers.referer,
    });
    if (req.url === "/redirect") {
      response.writeHead(302, { location: "/redirected" }).end();
      return;
    }
    if (req.url === "/redirected") redirectHits++;
    if (req.url !== "/events" && req.url !== "/revocation") {
      response.end("response");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      authorization: "Bearer service-token",
      "x-reflection": "service-token",
    });
    stream = response;
    response.write(
      ": ignored\r\nid: 12\r\nevent: delta\r\ndata: first\r\ndata: service-token\r",
    );
    response.write("\n\r");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const remote = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await page.evaluate(async (remote) => {
      const networkPath = "/src/plugins/network.ts",
        resourcesPath = "/src/plugins/resources.ts";
      const [{ PluginNetwork }, { PluginResources }] = await Promise.all([
        import(networkPath),
        import(resourcesPath),
      ]);
      const id = "different.plugin",
        owner = crypto.randomUUID();
      const resources = new PluginResources(
        location.origin,
        owner,
        id,
        "a".repeat(64),
      );
      const network = new PluginNetwork(
        { id, name: id, targets: [] },
        () => {},
        resources,
      );
      const history: any[] = [];
      const f = ((window as any).networkFixture = {
        history,
        resource: "events",
        network,
        resources,
        controller: new AbortController(),
      });
      f.approve = (id: string) =>
        resources
          .configure(
            {
              id,
              endpoint: remote + "/" + id,
              authorization: "Bearer service-token",
              methods: ["GET"],
              enabled: true,
            },
            true,
            () => true,
          )
          .find((grant: any) => grant.id === id).config_pin;
      f.run = (id: string, pin: string, requestId: number, overrides = {}) =>
        network.execute(
          "http",
          {
            resource: id,
            config_pin: pin,
            method: "GET",
            response_mode: "sse",
            headers: { "X-Correlation": "a" },
            ...overrides,
          },
          f.controller.signal,
          requestId,
          {
            isCurrent: () => true,
            event: (requestId: number, value: unknown) => {
              history.push({ requestId, value });
            },
          },
        );
      f.pin = f.approve("events");
      f.run("events", f.pin, 71).then(
        (value: unknown) => history.push({ requestId: 71, value }),
        (error: Error) => history.push(error.message),
      );
    }, remote);
    const history = () =>
      page.evaluate(() => (window as any).networkFixture.history);
    await expect
      .poll(history)
      .toEqual([
        {
          requestId: 71,
          value: {
            type: "sse-event",
            id: "12",
            event: "delta",
            data: "first\n[redacted]",
          },
        },
      ])
      .catch((error) => {
        throw Error(JSON.stringify(diagnostics), { cause: error });
      });
    const rejected = await page.evaluate(async () => {
      const f = (window as any).networkFixture;
      return await Promise.all(
        [
          f.run("events", f.pin, 72),
          f.run("events", f.pin, 73, {
            headers: { aUtHoRiZaTiOn: "Bearer guest-override" },
          }),
          f.run("redirect", f.approve("redirect"), 74, {
            response_mode: "discard",
          }),
          f.run("nocors", f.approve("nocors"), 75, {
            response_mode: "discard",
          }),
        ].map((request) =>
          request.then(
            () => "accepted",
            (error: Error) => error.message,
          ),
        ),
      );
    });
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.stringContaining("already has an active"),
        expect.stringContaining("host-owned"),
        "Failed to fetch",
        "Failed to fetch",
      ]),
    );
    stream!.end("data: last\n\ndata: incomplete");
    await expect.poll(history).toEqual([
      {
        requestId: 71,
        value: {
          type: "sse-event",
          id: "12",
          event: "delta",
          data: "first\n[redacted]",
        },
      },
      {
        requestId: 71,
        value: { type: "sse-event", id: "12", event: "message", data: "last" },
      },
      {
        requestId: 71,
        value: {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-reflection": "[redacted]",
          },
          body: "",
        },
      },
    ]);
    expect(requests.find((r) => r.url === "/events")).toEqual({
      url: "/events",
      auth: "Bearer service-token",
      cookie: undefined,
      accept: "text/event-stream",
      referrer: undefined,
    });
    expect(requests.filter((r) => r.url === "/events")).toHaveLength(1);
    expect(redirectHits).toBe(0);
    await page.evaluate(() => {
      const f = (window as any).networkFixture;
      const pin = f.approve("revocation");
      f.run("revocation", pin, 76).then(
        (value: unknown) => f.history.push({ requestId: 76, value }),
        (error: Error) =>
          f.history.push({ requestId: 76, error: error.message }),
      );
    });
    await expect.poll(history).toHaveLength(4);
    const disconnected = new Promise<void>((resolve) =>
      stream!.once("close", () => resolve()),
    );
    await page.evaluate(() =>
      (window as any).networkFixture.approve("revocation"),
    );
    await disconnected;
    await expect.poll(history).toHaveLength(5);
    expect((await history())[4]).toMatchObject({
      requestId: 76,
      error: expect.any(String),
    });
    expect(requests.filter((r) => r.url === "/revocation")).toHaveLength(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
