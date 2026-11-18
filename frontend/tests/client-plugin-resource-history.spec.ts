import { expect, test } from "@playwright/test";

test("history retirement aborts old requests and keeps only existing owner/artifact grants usable", async ({
  page,
}) => {
  await page.route("**/resource-history-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Resource history fixture</title>",
    }),
  );
  await page.goto("/resource-history-fixture");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/resources.ts";
    const { PluginResources } = await import(path);
    const owner = crypto.randomUUID(),
      artifact = "a".repeat(64),
      id = "history.fixture";
    const vault = new PluginResources(location.origin, owner, id, artifact);
    const list = vault.configure(
      {
        id: "paid",
        endpoint: "https://resource.example.test/complete",
        authorization: "Bearer private",
        enabled: true,
      },
      true,
    ) as { config_pin: string }[];
    const payload = {
      resource: "paid",
      method: "POST",
      config_pin: list[0]!.config_pin,
    };
    const old = vault.network(payload);
    vault.retireRequests();
    const current = vault.network(payload);
    const retainedPin =
      (vault.list() as { config_pin: string }[])[0]!.config_pin ===
      list[0]!.config_pin;
    const updated = vault.configure(
      { id: "paid", endpoint: current.url, authorization: "", enabled: true },
      true,
    ) as { config_pin: string }[];
    const configured = vault.network({
      ...payload,
      config_pin: updated[0]!.config_pin,
    });
    const replaced = new PluginResources(
      location.origin,
      owner,
      id,
      "b".repeat(64),
    );
    replaced.retireRequests();
    let replacedDenied = false;
    try {
      replaced.network({ ...payload, config_pin: updated[0]!.config_pin });
    } catch {
      replacedDenied = true;
    }
    const other = new PluginResources(
      location.origin,
      owner + "other",
      id,
      artifact,
    );
    other.retireRequests();
    const otherOwnerEmpty = (other.list() as unknown[]).length === 0;
    vault.close();
    vault.retireRequests();
    let closedDenied = false;
    try {
      vault.network({ ...payload, config_pin: updated[0]!.config_pin });
    } catch {
      closedDenied = true;
    }
    const crossTab = new PluginResources(location.origin, owner, id, artifact);
    const beforeStorage = crossTab.network({
      ...payload,
      config_pin: updated[0]!.config_pin,
    });
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    crossTab.retireRequests();
    let storageDenied = false;
    try {
      crossTab.network({ ...payload, config_pin: updated[0]!.config_pin });
    } catch {
      storageDenied = true;
    }
    const safeList = !JSON.stringify(crossTab.list()).includes("private");
    for (const instance of [replaced, other, crossTab]) instance.close();
    return {
      oldAborted: old.signal.aborted,
      oldCurrent: old.isCurrent(),
      retainedPin,
      currentWasUsable: current.headers.Authorization === "Bearer private",
      configAborted: current.signal.aborted,
      configCurrent: current.isCurrent(),
      configuredRetainedCredential:
        configured.headers.Authorization === "Bearer private",
      configuredAborted: configured.signal.aborted,
      configuredCurrent: configured.isCurrent(),
      replacedDenied,
      otherOwnerEmpty,
      closedDenied,
      storageDenied,
      storageAborted: beforeStorage.signal.aborted,
      storageCurrent: beforeStorage.isCurrent(),
      safeList,
    };
  });
  expect(result).toEqual({
    oldAborted: true,
    oldCurrent: false,
    retainedPin: true,
    currentWasUsable: true,
    configAborted: true,
    configCurrent: false,
    configuredRetainedCredential: true,
    configuredAborted: true,
    configuredCurrent: false,
    replacedDenied: true,
    otherOwnerEmpty: true,
    closedDenied: true,
    storageDenied: true,
    storageAborted: true,
    storageCurrent: false,
    safeList: true,
  });
});
