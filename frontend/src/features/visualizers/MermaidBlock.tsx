import { useEffect, useId, useRef, useState } from "react";
import { safeMermaid } from "./policy";
import { useVisualTheme } from "./theme";
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;
/** Serialized initialization/parse/render: Mermaid owns module-global configuration. */
export default function MermaidBlock({
  source,
  fallback,
}: {
  source: string;
  fallback: React.ReactNode;
}) {
  const theme = useVisualTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [result, setResult] = useState<{
    source: string;
    theme: string;
    svg: string;
  } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stale = false;
    if (!safeMermaid(source)) return;
    const renderId = `visual-${id}-${++serial}`;
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (stale) return;
        let temporary: HTMLDivElement | undefined;
        try {
          const mermaid = (await import("mermaid")).default;
          if (stale) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme: theme === "dark" ? "dark" : "neutral",
            fontFamily: "system-ui",
            htmlLabels: false,
            maxTextSize: 12000,
            maxEdges: 240,
            flowchart: { htmlLabels: false },
            secure: [
              "securityLevel",
              "startOnLoad",
              "maxTextSize",
              "maxEdges",
              "htmlLabels",
              "flowchart",
              "theme",
              "fontFamily",
              "secure",
            ],
          });
          if (!(await mermaid.parse(source, { suppressErrors: true })) || stale)
            return;
          temporary = document.createElement("div");
          temporary.className = "visual-mermaid-temporary";
          document.body.append(temporary);
          const { svg } = await mermaid.render(renderId, source, temporary);
          if (svg.length > 1024 * 1024) return;
          const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
          if (
            doc.querySelector(
              "parsererror,script,foreignObject,a,image,iframe,object,embed,animate,set",
            )
          )
            return;
          for (const el of doc.querySelectorAll("*")) {
            for (const attribute of [...el.attributes]) {
              if (
                attribute.name === "xmlns" ||
                attribute.name === "xmlns:xlink"
              )
                continue;
              if (
                /^on|href|src/i.test(attribute.name) ||
                /(?:https?:|data:|javascript:|@import|expression\s*\()/i.test(
                  attribute.value,
                )
              )
                return;
              for (const match of attribute.value.matchAll(
                /url\s*\(([^)]+)\)/gi,
              ))
                if (!/^['"]?#[\w-]+['"]?$/.test(match[1])) return;
            }
          }
          for (const style of doc.querySelectorAll("style")) {
            if (
              /@import|https?:|data:|javascript:|expression\s*\(/i.test(
                style.textContent ?? "",
              )
            )
              return;
            for (const match of (style.textContent ?? "").matchAll(
              /url\s*\(([^)]+)\)/gi,
            ))
              if (!/^['"]?#[\w-]+['"]?$/.test(match[1])) return;
          }
          if (!stale)
            setResult({
              source,
              theme,
              svg: new XMLSerializer().serializeToString(doc.documentElement),
            });
        } catch {
          /* Invalid syntax and lazy load failures retain source quietly. */
        } finally {
          temporary?.remove();
          document.getElementById(`d${renderId}`)?.remove();
        }
      });
    return () => {
      stale = true;
    };
  }, [source, theme, id]);
  const svg =
    result?.source === source && result.theme === theme ? result.svg : null;
  return svg ? (
    <div
      ref={host}
      className="visual-mermaid"
      data-testid="mermaid-preview"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  ) : (
    <>{fallback}</>
  );
}
