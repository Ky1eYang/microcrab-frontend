import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("same plugin ID, release version and ABI cannot retain authority after bytes change", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route(
    "https://artifact-identity.example.test/mcp",
    async (route) => {
      const rpc = route.request().postDataJSON();
      if (rpc.method === "notifications/initialized") {
        await route.fulfill({ status: 202, body: "" });
        return;
      }
      const result =
        rpc.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "identity-fixture", version: "1" },
            }
          : { tools: [] };
      await route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result } });
    },
  );
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const resourcesPath = "/src/plugins/resources.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginResources } = await import(resourcesPath);
    const owner = crypto.randomUUID();
    const id = "microcrab.mcp-bridge";
    const session = "artifact-identity";
    const endpoint = "https://artifact-identity.example.test/mcp";
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    const vaults: InstanceType<typeof PluginResources>[] = [];
    const vault = (artifact: string) => {
      const value = new PluginResources(location.origin, owner, id, artifact);
      vaults.push(value);
      return value;
    };
    const run = (artifact: string) =>
      registry.executeTool(
        { plugin: id, artifact, action: "list" },
        {
          invocation_id: crypto.randomUUID(),
          session_id: session,
          parent_session_id: session,
          call_id: crypto.randomUUID(),
          catalog_digest: "artifact-identity-catalog",
          deadline_ms: 0,
        },
        new AbortController().signal,
      );
    const configure = async (authorization: string) => {
      await registry.render(id, "sidebar");
      registry.setVariable(id, "id", "retained");
      registry.setVariable(id, "endpoint", endpoint);
      registry.setVariable(id, "authorization", authorization);
      registry.setVariable(id, "enabled", "true");
      await registry.action(id, "save-config");
    };
    try {
      await registry.initialize();
      await registry.setSession(session);
      await registry.setEnabled(id, session, true);
      const before = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id);
      if (!before?.artifact)
        throw Error(
          "Build/install the maintained MCP component before this suite",
        );
      await configure("Bearer retained-artifact-secret");
      await run(before.artifact);
      const originalVault = vault(before.artifact);
      const originalConfig = originalVault.list()[0];
      const originalRequest = originalVault.network({
        method: "POST",
        resource: "retained",
        config_pin: originalConfig.config_pin,
      });

      // A valid inert Component custom section changes the exact bytes without
      // changing the real guest's manifest, imports, exports or executable code.
      const name = new TextEncoder().encode("microcrab-artifact-identity-test");
      const changed = new Uint8Array(before.bytes.length + name.length + 3);
      changed.set(before.bytes);
      changed.set([0, name.length + 1, name.length], before.bytes.length);
      changed.set(name, before.bytes.length + 3);
      await registry.importPlugin(changed, { replace: true, expectedId: id });
      const after = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id);
      if (!after?.artifact) throw Error("Replacement artifact is unavailable");
      let staleDispatch = "";
      try {
        await run(before.artifact);
      } catch (error) {
        staleDispatch = String(error);
      }
      await run(after.artifact);
      const replacedVault = vault(after.artifact);
      const retainedConfig = replacedVault.list()[0];
      let staleGrant = "";
      try {
        replacedVault.network({
          method: "POST",
          resource: "retained",
          config_pin: originalConfig.config_pin,
        });
      } catch (error) {
        staleGrant = String(error);
      }
      // The owner explicitly authorizes the replacement; blank authorization
      // retains the saved credential for this exact endpoint.
      await configure("");
      await run(after.artifact);
      const authorizedVault = vault(after.artifact);
      const authorizedConfig = authorizedVault.list()[0];
      const authorizedRequest = authorizedVault.network({
        method: "POST",
        resource: "retained",
        config_pin: authorizedConfig.config_pin,
      });
      return {
        before: {
          id: before.manifest.id,
          version: before.manifest.version,
          imports: before.imports,
          artifact: before.artifact,
          bytes: Array.from(before.bytes),
        },
        after: {
          id: after.manifest.id,
          version: after.manifest.version,
          imports: after.imports,
          artifact: after.artifact,
          bytes: Array.from(after.bytes),
        },
        staleDispatch,
        staleGrant,
        retainedConfig,
        originalConfig,
        authorizedConfig,
        credentialRetained:
          authorizedRequest.headers.Authorization ===
          originalRequest.headers.Authorization,
        credentialWasConfigured:
          authorizedRequest.headers.Authorization ===
          "Bearer retained-artifact-secret",
      };
    } finally {
      registry.dispose();
      for (const value of vaults) value.close();
      PluginResources.reset(location.origin, owner, id);
    }
  });
  expect(actual.after.id).toBe(actual.before.id);
  expect(actual.after.version).toBe(actual.before.version);
  expect(actual.after.imports).toEqual(actual.before.imports);
  for (const artifact of [actual.before, actual.after]) {
    expect(artifact.artifact).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.artifact).toBe(
      createHash("sha256").update(Buffer.from(artifact.bytes)).digest("hex"),
    );
  }
  expect(actual.after.artifact).not.toBe(actual.before.artifact);
  expect(actual.staleDispatch).toContain("artifact is unavailable or changed");
  expect(actual.staleGrant).toContain("Resource grant is disabled");
  expect(actual.retainedConfig).toMatchObject({
    id: "retained",
    endpoint: "https://artifact-identity.example.test/mcp",
    enabled: false,
    requires_reenable: true,
    config_pin: actual.originalConfig.config_pin,
  });
  expect(actual.authorizedConfig).toMatchObject({
    id: "retained",
    enabled: true,
    requires_reenable: false,
  });
  expect(actual.authorizedConfig.config_pin).not.toBe(
    actual.originalConfig.config_pin,
  );
  expect(actual.credentialRetained).toBe(true);
  expect(actual.credentialWasConfigured).toBe(true);
});
