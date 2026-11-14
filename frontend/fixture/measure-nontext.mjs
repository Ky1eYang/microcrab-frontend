import { chromium } from "@playwright/test";
const b = await chromium.launch();
const lum = ([r,g,bb]) => { const f = v => { v/=255; return v<=0.03928? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(bb); };
for (const theme of ["light","dark"]) for (const [id, sel, prop] of [
  ["tools-mixed-status", "[data-testid=tool-row] svg", "color"],
  ["subagent-cancelled", "[data-testid=subagent-item-status] svg, .subagent-status-dot", "color"],
  ["permissions-json-invalid", "[data-testid=session-permissions] textarea", "borderTopColor"],
  ["permissions-tools-ready", "[data-testid=session-permissions] .ghost-btn", "borderTopColor"],
  ["permissions-tools-ready", ".perm-select", "borderTopColor"],
  ["permissions-tools-ready", ".perm-check-row input[type=checkbox]", "borderTopColor"],
  ["permission-request", "[data-testid=permission-request] .primary-btn:disabled", "borderTopColor"],
  ["permissions-tools-ready", "[data-testid=session-permissions] [role=radio], [data-testid=session-permissions] input[type=radio]", "borderTopColor"],
]) {
  const p = await b.newPage();
  await p.goto(`http://127.0.0.1:18130/fixture/?scenario=${id}&theme=${theme}&locale=en`);
  await p.waitForFunction(() => document.documentElement.dataset.fixture, null, { timeout: 15000 }).catch(()=>{});
  await p.waitForTimeout(600);
  const vals = await p.evaluate(([sel, prop]) => {
    const parse = c => (c.match(/[\d.]+/g)||[]).map(Number);
    const bgOf = el => { for (let e = el.parentElement; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.length && (c[3] ?? 1) > 0.5) return c; } return [255,255,255]; };
    return [...document.querySelectorAll(sel)].slice(0,6).map(el => ({ fg: parse(getComputedStyle(el)[prop]), bg: bgOf(el), st: el.closest("[data-status]")?.getAttribute("data-status") }));
  }, [sel, prop]);
  const out = vals.map(v => { const a=lum(v.fg), c=lum(v.bg); return `${v.st ?? ""}:${((Math.max(a,c)+.05)/(Math.min(a,c)+.05)).toFixed(2)}`; });
  console.log(theme, id, prop, [...new Set(out)].join(" "));
  // focus ring
  await p.close();
}
await b.close();
