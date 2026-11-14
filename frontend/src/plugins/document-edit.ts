import type { EditDiagnostic } from "../features/content-inspection/ContentViewer";
import { resolvePath } from "./schema";
import type {
  Json,
  PluginRegistryAPI,
  PluginSurfaceDescriptor,
  ViewTarget,
} from "./types";

/** A save callback completes on the guest's correlated terminal receipt, not on
 * dispatch. Observation is read-only and never retries an uncertain mutation. */
export function savePluginDocument({
  registry,
  pluginId,
  target,
  surface,
  current,
  action,
  text,
  context,
  statePath,
}: {
  registry: PluginRegistryAPI;
  pluginId: string;
  target: ViewTarget;
  surface: PluginSurfaceDescriptor;
  current: () => boolean;
  action: string;
  text: string;
  context: Json;
  statePath: string;
}): Promise<void> {
  const prior = resolvePath(
    registry.view(pluginId, target, surface).vars,
    statePath,
  );
  if (
    prior &&
    typeof prior === "object" &&
    !Array.isArray(prior) &&
    ["saving", "queued", "unknown"].includes(String(prior.status))
  )
    return Promise.reject(
      new Error(
        typeof prior.detail === "string" && prior.detail
          ? prior.detail
          : "A document write is unresolved; observe its operation before saving again",
      ),
    );
  const editId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (!current())
          return finish(
            new Error(
              "Plugin document scope changed; the save result cannot be applied to this view",
            ),
          );
        const state = resolvePath(
          registry.view(pluginId, target, surface).vars,
          statePath,
        );
        if (
          !state ||
          typeof state !== "object" ||
          Array.isArray(state) ||
          state.edit_id !== editId
        )
          return;
        if (state.status === "saved") finish();
        else if (
          ["error", "conflict", "unknown"].includes(String(state.status))
        )
          finish(
            new Error(
              typeof state.detail === "string" && state.detail
                ? state.detail
                : `Plugin document save ${state.status}`,
            ),
          );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    // Host effects have their own deadline; this bounds a malformed guest that
    // never publishes a receipt. Timing out does not authorize mutation replay.
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Plugin document save receipt timed out; reconcile the operation before saving again",
          ),
        ),
      20_000,
    );
    unsubscribe = registry.subscribe(check);
    if (!current())
      return finish(new Error("Plugin document is no longer active"));
    void registry
      .action(
        pluginId,
        action,
        { value: text, context, edit_id: editId },
        surface,
      )
      .then(check)
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

export function observePluginDocument({
  registry,
  pluginId,
  target,
  surface,
  current,
  action,
  statePath,
}: Omit<
  Parameters<typeof savePluginDocument>[0],
  "text" | "context"
>): Promise<void> {
  const read = () =>
    resolvePath(registry.view(pluginId, target, surface).vars, statePath);
  const prior = read();
  if (!prior || typeof prior !== "object" || Array.isArray(prior))
    return Promise.reject(
      new Error("Plugin document has no operation receipt"),
    );
  const operation = prior.operation_id;
  const editId = prior.edit_id;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    let observing = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (!current())
          return finish(new Error("Plugin document operation scope changed"));
        const state = read();
        if (
          !state ||
          typeof state !== "object" ||
          Array.isArray(state) ||
          state.operation_id !== operation ||
          state.edit_id !== editId
        )
          return finish(
            new Error("Plugin document operation identity changed"),
          );
        if (typeof state.observe_request === "number") {
          observing = true;
          return;
        }
        if (
          !dispatched ||
          (!observing && ["unknown", "queued"].includes(String(state.status)))
        )
          return;
        if (state.status === "saved") finish();
        else if (
          ["error", "conflict", "unknown", "queued"].includes(
            String(state.status),
          )
        )
          finish(
            new Error(
              typeof state.detail === "string" && state.detail
                ? state.detail
                : `Plugin operation is ${state.status}`,
            ),
          );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Plugin operation observation timed out; no mutation was retried",
          ),
        ),
      20_000,
    );
    unsubscribe = registry.subscribe(check);
    if (!current())
      return finish(new Error("Plugin document is no longer active"));
    void registry
      .action(pluginId, action, null, surface)
      .then(() => {
        dispatched = true;
        check();
      })
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}

/** Validation owns a separate correlated state channel, independent of operation receipts. */
export function validatePluginDocument({
  registry,
  pluginId,
  target,
  surface,
  current,
  action,
  text,
  context,
  statePath,
}: Parameters<typeof savePluginDocument>[0]): Promise<EditDiagnostic[]> {
  const validationId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: Error, diagnostics: EditDiagnostic[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(diagnostics);
    };
    const check = () => {
      try {
        if (!current())
          return finish(new Error("Plugin document validation scope changed"));
        const state = resolvePath(
          registry.view(pluginId, target, surface).vars,
          statePath,
        );
        if (
          !state ||
          typeof state !== "object" ||
          Array.isArray(state) ||
          state.validation_id !== validationId
        )
          return;
        if (state.status !== "validated") return;
        if (!Array.isArray(state.diagnostics))
          throw new Error("Plugin validation diagnostics must be an array");
        const diagnostics: EditDiagnostic[] = state.diagnostics.map((item) => {
          if (
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            typeof item.message !== "string" ||
            !["error", "warning"].includes(String(item.severity)) ||
            (item.path !== undefined && typeof item.path !== "string") ||
            (item.from !== undefined &&
              (!Number.isInteger(item.from) ||
                Number(item.from) < 0 ||
                Number(item.from) > text.length)) ||
            (item.to !== undefined &&
              (!Number.isInteger(item.to) ||
                Number(item.to) < Number(item.from ?? 0) ||
                Number(item.to) > text.length))
          )
            throw new Error("Plugin supplied malformed edit diagnostics");
          return item as unknown as EditDiagnostic;
        });
        finish(undefined, diagnostics);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Plugin document validation timed out")),
      20_000,
    );
    // Subscribe before dispatch: a synchronous publication must not be missed.
    unsubscribe = registry.subscribe(check);
    if (!current())
      return finish(new Error("Plugin document is no longer active"));
    void registry
      .action(
        pluginId,
        action,
        { value: text, context, validation_id: validationId },
        surface,
      )
      .then(check)
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
  });
}
