/* Opt-in Designer fixture entry: http://127.0.0.1:<port>/fixture/?scenario=<id>&theme=light|dark&locale=zh-CN|en
 * Refuses to run anywhere but loopback. Not part of the production build
 * (vite build only uses frontend/index.html). */
import { installPageShim } from "./page-shim";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const params = new URLSearchParams(location.search);
const id = params.get("scenario");
const root = document.getElementById("main")!;

function banner(textContent: string, kind: "info" | "error" = "info") {
  const el = document.createElement("div");
  el.setAttribute("data-testid", "fixture-banner");
  el.dataset.kind = kind;
  el.textContent = textContent;
  el.style.cssText = `position:fixed;left:8px;bottom:8px;z-index:99999;font:11px/1.3 system-ui;padding:3px 8px;border-radius:6px;opacity:.85;pointer-events:none;${
    kind === "error"
      ? "background:#b91c1c;color:#fff"
      : "background:#111;color:#fff"
  }`;
  document.body.appendChild(el);
  return el;
}

async function index() {
  const { SCENARIOS } = await import("./scenarios");
  const { AUTH_SCENARIOS } = await import("./auth-transition");
  const list = [
    ...AUTH_SCENARIOS.map((id) => [
      id,
      "Render-only auth showcase (no navigation)",
    ]),
    ...Object.entries(SCENARIOS).map(([k, s]) => [k, s.title]),
    [
      "attachments",
      "Attachment rail + unavailable thumbnails (click the first image for the original preview)",
    ],
  ];
  root.innerHTML = `<main style="font:14px system-ui;max-width:900px;margin:24px auto;padding:0 16px;color:var(--text,#111)">
    <h1 style="font-size:18px">microcrab fixture scenarios (opt-in, loopback only)</h1>
    <p>Fixture-only (tests/native-fixture.ts contract). Not backend verification. Each link restages on reload.</p>
    <table style="border-collapse:collapse">${list
      .map(
        ([k, t]) =>
          `<tr><td style="padding:4px 8px"><code>${k}</code></td><td style="padding:4px 8px">${t}</td><td style="padding:4px 8px;white-space:nowrap">${[
            "light",
            "dark",
          ]
            .flatMap((th) =>
              ["zh-CN", "en"].map(
                (lo) =>
                  `<a href="?scenario=${k}&theme=${th}&locale=${lo}">${th}/${lo}</a>`,
              ),
            )
            .join(" · ")}</td></tr>`,
      )
      .join("")}</table></main>`;
}

async function attachments() {
  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { ComposerImages } = await import("../src/features/composer/Images");
  const { BlockView } = await import("../src/features/views");
  const { setActiveLocale } = await import("../src/i18n");
  await import("../src/styles/tokens.css");
  await import("../src/styles/chrome.css");
  await import("../src/styles/components.css");
  await import("../src/styles/interaction-polish.css");
  setActiveLocale((params.get("locale") as "en" | "zh-CN") ?? "zh-CN");
  document.body.style.background = "var(--bg)";
  // Same payloads as tests/images-presentation-browser.spec.ts mountImages().
  const canvas = document.createElement("canvas");
  canvas.width = 2400;
  canvas.height = 1600;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#4b6bfb";
  g.fillRect(0, 0, 2400, 1600);
  g.fillStyle = "#fff";
  g.font = "200px sans-serif";
  g.fillText("2400×1600", 600, 900);
  const source = canvas.toDataURL("image/png");
  const blob = await new Promise<Blob>((r) =>
    canvas.toBlob((b) => r(b!), "image/png"),
  );
  const previewUrl = URL.createObjectURL(blob);
  const initial = Array.from({ length: 7 }, (_, i) => ({
    id: `draft-${i}`,
    name: `clipboard-${i}-long-image-name.png`,
    mediaType: "image/png",
    previewUrl,
  }));
  const block = (bid: string, text: string, attachmentsList: unknown[]) => ({
    id: bid,
    sessionId: "s",
    messageId: bid,
    partId: "text",
    role: "user",
    kind: "text",
    stream: "complete",
    fold: "auto",
    isCompact: false,
    tool: null,
    payload: {
      text,
      mime: "text/markdown",
      formatHint: "markdown",
      attachments: attachmentsList,
      structured: null,
      content: [],
      outputPaths: [],
      providerMetadata: null,
    },
  });
  const h = React.createElement;
  function Fixture() {
    const [images, setImages] = React.useState(initial);
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "transcript-inner" },
        h(BlockView as any, {
          block: block("historical", "Caption appears once", [
            {
              partId: "historical-image",
              mime: "image/png",
              name: "history.png",
              url: source,
            },
            {
              partId: "omitted-image",
              mime: "image/png",
              name: "omitted.png",
              sourceOmitted: true,
              url: "https://example.invalid/omitted-image",
            },
            {
              partId: "broken-image",
              mime: "image/png",
              name: "broken.png",
              url: "data:image/png;base64,invalid",
            },
          ]),
        }),
      ),
      h(
        "div",
        { className: "home-composer-box", style: { marginTop: 24 } },
        h(ComposerImages as any, {
          images,
          onRemove: (rid: string) =>
            setImages((c) => c.filter((im) => im.id !== rid)),
        }),
        h("textarea", {
          className: "home-composer-textarea",
          "aria-label": "Draft text",
          defaultValue: "Keep this draft",
        }),
      ),
    );
  }
  root.style.cssText = "padding:16px;max-width:820px;margin:auto";
  createRoot(root).render(h(Fixture));
}

async function run() {
  if (!LOOPBACK.includes(location.hostname)) {
    banner("Fixture disabled: loopback hosts only", "error");
    return;
  }
  if (!id) return index();
  const { AUTH_SCENARIOS, renderAuthFixture } =
    await import("./auth-transition");
  if (AUTH_SCENARIOS.includes(id)) return renderAuthFixture(id, root, params);
  if (id === "attachments") return attachments();
  const { SCENARIOS } = await import("./scenarios");
  const scenario = SCENARIOS[id];
  if (!scenario) {
    banner(`Unknown scenario: ${id}`, "error");
    return index();
  }
  const page = installPageShim();
  const backend = await scenario.stage(page as any);
  (window as any).__fixture = { id, backend };
  if (!location.hash)
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#session/s1`,
    );
  const label = banner(`fixture: ${id} · staging…`);
  // These are child presentation states, outside the closed execution vocabulary.
  if (
    ["subagent-idle", "subagent-pending", "subagent-weird-unknown"].includes(id)
  ) {
    const { renderChildStatus } = await import("./child-status");
    await renderChildStatus(
      root,
      id.slice("subagent-".length),
      (params.get("locale") as "zh-CN" | "en") ?? "zh-CN",
    );
    label.textContent = `fixture: ${id}`;
    setTimeout(() => label.remove(), 2500);
    return;
  }
  await import("../src/main.tsx");
  try {
    await scenario.steps?.(backend);
    label.textContent = `fixture: ${id}`;
    document.documentElement.dataset.fixture = "ready";
    setTimeout(() => label.remove(), 2500);
  } catch (error) {
    label.dataset.kind = "error";
    label.style.background = "#b91c1c";
    label.textContent = `fixture ${id} failed: ${(error as Error).message}`;
    document.documentElement.dataset.fixture = "error";
  }
}
void run().catch((error: unknown) => {
  document.documentElement.dataset.fixture = "error";
  banner(
    `Fixture bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
    "error",
  );
});
