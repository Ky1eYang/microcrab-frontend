/* Minimal in-page steps used to reach a staged state (the same steps the
 * Playwright shots perform). Fails loudly instead of inventing state. */
export async function waitFor<T extends Element = HTMLElement>(selector: string, timeout = 8000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const el = document.querySelector<T>(selector);
    if (el && el.getClientRects().length > 0) return el;
    if (performance.now() - start > timeout) throw new Error(`fixture: timed out waiting for ${selector}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
export async function waitText(selector: string, pattern: RegExp, timeout = 8000) {
  const start = performance.now();
  for (;;) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && pattern.test(el.textContent ?? "")) return el;
    if (performance.now() - start > timeout) throw new Error(`fixture: ${selector} never matched ${pattern}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
export async function click(selector: string) {
  (await waitFor(selector)).click();
  await new Promise((r) => setTimeout(r, 60));
}
export async function clickText(scope: string, pattern: RegExp) {
  const start = performance.now();
  for (;;) {
    const el = [...document.querySelectorAll<HTMLElement>(`${scope} button`)].find((b) => pattern.test(b.textContent?.trim() ?? ""));
    if (el) { el.click(); await new Promise((r) => setTimeout(r, 60)); return; }
    if (performance.now() - start > 8000) throw new Error(`fixture: no button ${pattern} in ${scope}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
export async function fill(selector: string, value: string) {
  const el = await waitFor<HTMLInputElement | HTMLTextAreaElement>(selector);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  await new Promise((r) => setTimeout(r, 60));
}
export async function key(selector: string, keyName: string) {
  const el = await waitFor(selector);
  el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
}
/** Mirror of tests/host-fixture.ts connectHostUI (pairing code accepted by the fixture bridge). */
export async function connectHost() {
  // The header chip renders before bootstrap settles; retry until the dialog opens.
  for (let i = 0; i < 40 && !document.querySelector(".remote-connect-dialog"); i++) {
    await click('[data-testid="header-host-connection"]');
    await new Promise((r) => setTimeout(r, 150));
  }
  if (document.querySelector("#host-url")) await fill("#host-url", "ws://127.0.0.1:8788/host");
  await fill("#host-code", "test-pair");
  await clickText(".remote-connect-dialog", /^(配对并连接 Host|Pair and connect Host)$/);
  await waitText('[data-testid="header-host-connection"]', /已就绪|Ready/);
}
/** Expand every collapsed tool group until rows with each status are visible. */
export async function expandToolRows(statuses: string[], timeout = 8000) {
  const start = performance.now();
  for (;;) {
    for (const header of document.querySelectorAll<HTMLElement>('.tool-accordion-group-header[aria-expanded="false"]')) header.click();
    await new Promise((r) => setTimeout(r, 80));
    const missing = statuses.filter(
      (s) => ![...document.querySelectorAll(`[data-testid="tool-row"][data-status="${s}"]`)].some((el) => el.getClientRects().length > 0),
    );
    if (!missing.length) return;
    if (performance.now() - start > timeout) throw new Error(`fixture: tool rows never visible: ${missing.join(", ")}`);
  }
}
/** Fixture-only probe: shows the live prefers-reduced-motion value and the running glyph's computed animation. */
export function motionProbe() {
  const id = "fixture-motion-probe";
  document.getElementById(id)?.remove();
  const box = document.createElement("output");
  box.id = id;
  box.setAttribute("data-testid", "fixture-motion-probe");
  box.style.cssText =
    "position:fixed;right:8px;bottom:8px;z-index:99999;font:12px/1.4 monospace;padding:4px 8px;border:1px solid #888;background:#fff;color:#111";
  const update = () => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const glyph = document.querySelector('[data-testid="tool-row"][data-status="running"] svg');
    const name = glyph ? getComputedStyle(glyph).animationName || "none" : "(no running row)";
    box.textContent = `prefers-reduced-motion: ${reduce ? "reduce" : "no-preference"} · running glyph animation: ${name}`;
    box.dataset.reduce = String(reduce);
    box.dataset.animation = name;
  };
  document.body.appendChild(box);
  update();
  setInterval(update, 250);
}
