import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

// These contract checks use browser imports so they exercise the host parser and
// subscription ordering without relying on a guest mutation or server write.
test("native capability declarations reject malformed formats and unbound validation channels", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/schema.ts";
    const { validateTree } = await import(path);
    const editable = {
      edit_action: "save",
      edit_value: { $ref: "full" },
      edit_context: { $ref: "context" },
      edit_state: { $ref: "receipt" },
      edit_validate_action: "validate",
      edit_validation_state: { $ref: "validation" },
      edit_notice: { $ref: "notice" },
      allowed_formats: ["json", "raw"],
    };
    const accepts = (type: string, props: unknown) => {
      try {
        validateTree({ type, props });
        return true;
      } catch {
        return false;
      }
    };
    return {
      valid: accepts("payload", editable),
      input: accepts("input", {
        clear_action: "clear",
        clear_label: { $ref: "label" },
      }),
      invalid: [
        accepts("payload", { allowed_formats: [] }),
        accepts("payload", { allowed_formats: ["json", "json"] }),
        accepts("payload", { allowed_formats: ["html"] }),
        accepts("payload", { allowed_formats: { $ref: "formats" } }),
        accepts("payload", { ...editable, edit_validation_state: {} }),
        accepts("payload", { ...editable, edit_validation_state: undefined }),
        accepts("payload", { ...editable, edit_validate_action: 1 }),
        accepts("text", { allowed_formats: ["raw"] }),
        accepts("input", { clear_action: "clear" }),
        accepts("button", { clear_action: "clear", clear_label: "Clear" }),
      ],
    };
  });
  expect(result.valid).toBe(true);
  expect(result.input).toBe(true);
  expect(result.invalid).toEqual(Array(10).fill(false));
});

test("validation subscribes before dispatch and correlates its own receipt despite an unknown write", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/document-edit.ts";
    const { validatePluginDocument } = await import(path);
    const listeners = new Set<() => void>();
    const surface = { surface_id: "same-surface", target: "sidebar" };
    const operation = {
      status: "unknown",
      edit_id: "old-edit",
      operation_id: "retained-write",
    };
    const vars: any = {
      operation,
      validation: {
        validation_id: "stale",
        status: "validated",
        diagnostics: [],
      },
    };
    let subscribedBeforeDispatch = false;
    let dispatchedSurface: unknown;
    let dispatchFinished!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      dispatchFinished = resolve;
    });
    let publish!: () => void;
    const registry = {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      view() {
        return { vars };
      },
      async action(
        _plugin: string,
        _action: string,
        payload: any,
        actualSurface: unknown,
      ) {
        subscribedBeforeDispatch = listeners.size === 1;
        dispatchedSurface = actualSurface;
        // A wrong correlation must not finish this Promise, even with valid data.
        vars.validation = {
          validation_id: "other-editor",
          status: "validated",
          diagnostics: [],
        };
        listeners.forEach((listener) => listener());
        publish = () => {
          vars.validation = {
            validation_id: payload.validation_id,
            status: "validated",
            diagnostics: [
              { path: "/a~1b", message: "read-only", severity: "error" },
            ],
          };
          listeners.forEach((listener) => listener());
        };
        dispatchFinished();
      },
    };
    let settled = false;
    const pending = validatePluginDocument({
      registry,
      pluginId: "generic",
      target: "sidebar",
      surface,
      current: () => true,
      action: "validate",
      text: "{}",
      context: { captured: true },
      statePath: "validation",
    }).then((diagnostics: unknown) => {
      settled = true;
      return diagnostics;
    });
    await dispatched;
    await Promise.resolve();
    const waited = !settled;
    publish();
    const diagnostics = await pending;
    return {
      subscribedBeforeDispatch,
      waited,
      diagnostics,
      sameSurface: dispatchedSurface === surface,
      operation: vars.operation,
      listeners: listeners.size,
    };
  });
  expect(result).toEqual({
    subscribedBeforeDispatch: true,
    waited: true,
    sameSurface: true,
    listeners: 0,
    diagnostics: [{ path: "/a~1b", message: "read-only", severity: "error" }],
    operation: {
      status: "unknown",
      edit_id: "old-edit",
      operation_id: "retained-write",
    },
  });
});

test("State search clears within a fixed-width field", async ({ page }) => {
  await nativeBackend(page);
  await maintainedPluginBundle(page);
  await page.goto("/#/session/s1/plugins/microcrab.state-viewer");
  const field = page.getByPlaceholder("搜索名称或值", { exact: true });
  await expect(field).toBeVisible({ timeout: 20_000 });
  const wrapper = field.locator("..");
  const initial = await wrapper.boundingBox();
  await field.fill("no matching key");
  const clear = wrapper.getByRole("button", { name: "清除搜索", exact: true });
  await expect(clear).toBeVisible();
  const filled = await wrapper.boundingBox();
  expect(filled?.width).toBe(initial?.width);
  await clear.click();
  await expect(field).toHaveValue("");
  await expect(clear).toBeHidden();
  expect((await wrapper.boundingBox())?.width).toBe(initial?.width);
});
