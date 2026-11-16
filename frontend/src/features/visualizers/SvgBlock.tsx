import { useId, useMemo, type ReactNode } from "react";
import { sanitizeSvg } from "./svg-policy";

export default function SvgBlock({
  source,
  fallback,
  inline = false,
}: {
  source: string;
  fallback: ReactNode;
  inline?: boolean;
}) {
  const id = useId();
  const svg = useMemo(() => sanitizeSvg(source, id), [source, id]);
  if (svg === null) return <>{fallback}</>;
  const Container = inline ? "span" : "div";
  const Surface = inline ? "span" : "div";
  return (
    <Container
      className="visual-svg-container"
      data-testid="svg-preview"
      data-inline={inline || undefined}
      style={{
        display: "block",
        maxWidth: "100%",
        minWidth: 0,
        overflow: "auto",
        color: "var(--text, currentColor)",
        margin: inline ? "0.5rem auto" : undefined,
      }}
    >
      <Surface
        className="visual-svg-surface"
        style={inline ? { display: "block" } : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Container>
  );
}
