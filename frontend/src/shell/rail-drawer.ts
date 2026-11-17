import { useSyncExternalStore } from "react";

/* Narrow-layout session drawer. Below 768px there is no icon rail; the
 * Header menu button opens the existing drawer. Open/close stays in the
 * shell, never in app state, the server or the URL. */
let open = false;
let trigger: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function setRailDrawerOpen(next: boolean, from?: HTMLElement | null) {
  if (from !== undefined) trigger = from;
  if (open === next) return;
  open = next;
  emit();
}

/** Element that opened the drawer; focus returns there on close. */
export function railDrawerTrigger() {
  return trigger;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRailDrawerOpen() {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
