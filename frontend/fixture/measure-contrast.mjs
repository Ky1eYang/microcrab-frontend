/* Run against a live fixture server: FIXTURE_PORT 18130 (npm run fixture). Writes /workspace/tmp/contrast.json. */
import { chromium } from "@playwright/test";
const targets = {
  "tools-mixed-status": [".tool-status-label, [data-testid=tool-row] [data-status] , .tool-group-outcome span", "[data-testid=tool-row]"],
  "permissions-tools-ready": ["[data-testid=session-permissions] button, [data-testid=session-permissions] [role=tab], [data-testid=session-permissions] label, [data-testid=session-permissions] p, [data-testid=session-permission-status]"],
  "permissions-json-invalid": ["[data-testid=session-permission-error-detail], [data-testid=session-permissions] [role=alert], [data-testid=session-permission-status]"],
  "inbox-mixed-draft": ["[data-testid=queue-dock] *:not(svg):not(path), [data-testid=composer-stop], [data-testid=steer-input], [data-testid=queue-input], .composer-model-pill, .composer-agent-pill"],
  "subagent-cancelled": ["[data-testid=subagent-item-status], .subagent-accordion-group button"],
  "subagent-interrupted": ["[data-testid=subagent-item-status]"],
  "subagent-failed": ["[data-testid=subagent-item-status]"],
  "permission-request": ["[data-testid=permission-request] *:not(svg):not(path)"],
  "round-limit-tools": ["[data-testid=round-limit-request] *:not(svg):not(path)"],
  "statistics-zero": [".dock-stat-row *, .dock-stat-row"],
  "client-tools-error": ["[data-testid=\"client-plugins-manager\"] *:not(svg):not(path)"],
  "settings": [".settings-dialog .settings-nav-item, .settings-dialog .settings-description, .settings-dialog .settings-row-label"],
};
const b = await chromium.launch();
const rows = [];
for (const theme of ["light", "dark"])
  for (const [id, [sel]] of Object.entries(targets)) {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await p.goto(`http://127.0.0.1:18130/fixture/?scenario=${id}&theme=${theme}&locale=en`);
    await p.waitForFunction(() => document.documentElement.dataset.fixture, null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    const res = await p.evaluate((sel) => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r,g,bb,a=1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r,g,bb,a]; };
      const blend = (top, under) => [0,1,2].map(i => top[i]*top[3] + under[i]*(1-top[3])).concat(1);
      const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; } } let base = [255,255,255,1]; for (const c of stack.reverse()) base = blend(c, base); return base; };
      const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
      const lum = ([r,g,bb]) => { const f = v => { v/=255; return v<=0.03928? v/12.92 : ((v+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(bb); };
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (!own || !el.getClientRects().length) continue;
        const cs = getComputedStyle(el); const bg = bgOf(el); let fg = parse(cs.color); const op = opacityOf(el);
        fg = blend([fg[0],fg[1],fg[2],fg[3]*op], bg);
        const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
        const disabled = el.closest("button,input,select,textarea")?.disabled ?? false;
        out.push({ text: [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(" ").slice(0,40), ratio: +ratio.toFixed(2), size: cs.fontSize, weight: cs.fontWeight, disabled, cls: (el.getAttribute("data-testid") || el.className || el.tagName).toString().slice(0,40) });
      }
      return out;
    }, sel);
    for (const r of res) rows.push({ theme, scenario: id, ...r });
    await p.close();
  }
await b.close();
const fs = await import("node:fs");
fs.writeFileSync("/workspace/tmp/contrast.json", JSON.stringify(rows, null, 1));
const fails = rows.filter(r => !r.disabled && r.ratio < 4.5);
console.log("measured", rows.length, "enabled<4.5:", fails.length, "disabled:", rows.filter(r=>r.disabled).length);
for (const r of fails) console.log(r.theme, r.scenario, JSON.stringify(r.text), r.ratio, r.size, r.cls);
console.log("--- disabled");
for (const r of rows.filter(r=>r.disabled)) console.log(r.theme, r.scenario, JSON.stringify(r.text), r.ratio, r.cls);
