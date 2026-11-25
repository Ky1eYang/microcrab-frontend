import {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  PromptResult,
  PromptSelection,
  ReadFrozenPrompt,
} from "./frozen-prompt";
import {
  classifyCurrentTools,
  type CurrentToolPermissions,
  type ReadCurrentPermissions,
} from "./tool-permission";

// External catalog and ancestor policy changes are not guaranteed to have an
// incremental signal. Expire a point-in-time observation without polling.
const MAX_OBSERVATION_AGE_MS = 30_000;

function subscribeBrowserAvailability(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    document.removeEventListener("visibilitychange", notify);
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function browserAvailability() {
  if (document.visibilityState !== "visible") return "hidden";
  return navigator.onLine ? "ready" : "offline";
}

export function useScopedPrompt(
  selection: PromptSelection,
  read: ReadFrozenPrompt,
  current: () => boolean,
  readPermissions: ReadCurrentPermissions,
  permissionScope: string | undefined,
  currentPermissionScope: () => string | undefined,
) {
  const browser = useSyncExternalStore(
    subscribeBrowserAvailability,
    browserAvailability,
  );
  const [promptAttempt, retryPrompt] = useState(0);
  const [permissionAttempt, refreshPermissions] = useState(0);
  const authority = useMemo(
    () => ({ selection, read, current }),
    [selection, read, current],
  );
  const promptRequest = useMemo(
    () => ({ authority, promptAttempt, browser }),
    [authority, promptAttempt, browser],
  );
  const [frozen, setFrozen] = useState<{
    authority: typeof authority;
    prompt: Extract<PromptResult, { status: "available" }>;
  }>();
  const [failure, setFailure] = useState<{
    request: typeof promptRequest;
    status: Exclude<PromptResult, { status: "available" }>["status"];
  }>();
  const scoped = current();
  const prompt =
    scoped && frozen?.authority === authority ? frozen.prompt : undefined;

  useLayoutEffect(() => {
    if (prompt || !current() || browser !== "ready") return;
    const controller = new AbortController();
    const { sessionId, lineage, epoch } = selection;
    async function load() {
      let result: PromptResult;
      try {
        result = await read({ sessionId, lineage, epoch }, controller.signal);
      } catch {
        result = { status: "failed" };
      }
      if (
        controller.signal.aborted ||
        !current() ||
        browserAvailability() !== "ready"
      )
        return;
      if (result.status === "available")
        setFrozen({ authority, prompt: result });
      else setFailure({ request: promptRequest, status: result.status });
    }
    void load();
    return () => controller.abort();
  }, [prompt, promptRequest, authority, browser, current, read, selection]);

  const permissionRequest = useMemo(
    () => ({
      authority,
      permissionAttempt,
      permissionScope,
      browser,
      readPermissions,
      currentPermissionScope,
    }),
    [
      authority,
      permissionAttempt,
      permissionScope,
      browser,
      readPermissions,
      currentPermissionScope,
    ],
  );
  const [observation, setObservation] = useState<{
    request: typeof permissionRequest;
    permissions?: CurrentToolPermissions;
    expiresAt: number;
  }>();
  const canReadPermissions =
    scoped && browser === "ready" && permissionScope !== undefined;
  const hasTools = !!prompt?.tools.length;
  useLayoutEffect(() => {
    if (!canReadPermissions || !hasTools || permissionScope === undefined)
      return;
    const controller = new AbortController();
    const expiresAt = Date.now() + MAX_OBSERVATION_AGE_MS;
    let expiration: number | undefined;
    async function load(scope: string) {
      let permissions: CurrentToolPermissions | undefined;
      try {
        const value = await readPermissions(scope, controller.signal);
        if (value) permissions = classifyCurrentTools(value);
      } catch {
        // A failed current read never replaces or hides frozen declarations.
      }
      if (
        controller.signal.aborted ||
        !current() ||
        browserAvailability() !== "ready" ||
        currentPermissionScope() !== scope
      )
        return;
      if (Date.now() >= expiresAt) permissions = undefined;
      setObservation({ request: permissionRequest, permissions, expiresAt });
      if (permissions) {
        expiration = window.setTimeout(() => {
          setObservation((previous) =>
            previous?.request === permissionRequest
              ? { ...previous, permissions: undefined }
              : previous,
          );
        }, expiresAt - Date.now());
      }
    }
    void load(permissionScope);
    return () => {
      controller.abort();
      clearTimeout(expiration);
    };
  }, [
    canReadPermissions,
    hasTools,
    permissionScope,
    permissionRequest,
    readPermissions,
    current,
    currentPermissionScope,
  ]);

  const settled =
    observation?.request === permissionRequest ? observation : undefined;
  return {
    prompt,
    failure:
      scoped && failure?.request === promptRequest
        ? failure.status
        : browser === "offline"
          ? "failed"
          : undefined,
    permissions:
      canReadPermissions && settled && Date.now() < settled.expiresAt
        ? settled.permissions
        : undefined,
    readingPermissions: canReadPermissions && hasTools && !settled,
    canReadPermissions,
    retry: () => retryPrompt((n) => n + 1),
    refresh: () => refreshPermissions((n) => n + 1),
  };
}
