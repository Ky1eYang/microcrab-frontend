import { useSyncExternalStore } from "react";

/** Narrow layout breakpoint; keep in sync with `@media (max-width: 767.98px)`. */
export const NARROW_QUERY = "(max-width: 767.98px)";
export const PLUGIN_DRAWER_QUERY = "(max-width: 999.98px)";

function pluginDrawerQuery() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(PLUGIN_DRAWER_QUERY)
    : null;
}
export function isPluginDrawerViewport() {
  return pluginDrawerQuery()?.matches ?? false;
}
function subscribePluginDrawer(onChange: () => void) {
  const media = pluginDrawerQuery();
  if (!media) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
export function usePluginDrawerViewport() {
  return useSyncExternalStore(
    subscribePluginDrawer,
    isPluginDrawerViewport,
    () => false,
  );
}

function query() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(NARROW_QUERY)
    : null;
}

function subscribe(onChange: () => void) {
  const media = query();
  if (!media) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function isNarrowViewport() {
  return query()?.matches ?? false;
}

/** True below 768px: rails become overlays and the inspector a bottom sheet. */
export function useNarrowViewport() {
  return useSyncExternalStore(subscribe, isNarrowViewport, () => false);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab / Shift+Tab inside `root`. Returns true when the key was handled. */
export function trapFocus(root: HTMLElement | null, event: KeyboardEvent) {
  if (!root || event.key !== "Tab") return false;
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.offsetParent !== null && !el.matches(":disabled"),
  );
  if (!items.length) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function focusFirst(root: HTMLElement | null) {
  const target = root?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
  target?.focus();
}
