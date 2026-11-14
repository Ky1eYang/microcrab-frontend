import type { KeyboardEvent } from "react";

/** WAI-ARIA tabs keyboard model with automatic activation: one tab stop per
 * tablist, Arrow keys wrap, Home/End jump. `select` may veto (return false),
 * e.g. when the Advanced JSON draft cannot be parsed. */
export function rovingTabKey<T extends string>(
  event: KeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  select: (value: T) => boolean | void,
) {
  const index = values.indexOf(current);
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown")
    next = (index + 1) % values.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
    next = (index - 1 + values.length) % values.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = values.length - 1;
  else return;
  event.preventDefault();
  if (next === index) return;
  if (select(values[next]) === false) return;
  // Tabs remain mounted when their panel changes. Move focus within this key
  // event so a delayed callback cannot steal a subsequent user focus change.
  event.currentTarget
    .querySelectorAll<HTMLElement>('[role="tab"]')
    [next]?.focus();
}
