import { lazy, Suspense } from "react";
import { safeMath } from "./policy";
const LazyMath = lazy(() =>
  import("./math-engine").catch(() => ({
    default: ({ raw }: { source: string; raw: string; display: boolean }) => (
      <>{raw}</>
    ),
  })),
);
/** A syntax parser is cheap; the engine, CSS and local glyph fonts remain asynchronous. */
export function MathNode({
  source,
  raw,
  display,
}: {
  source: string;
  raw: string;
  display: boolean;
}) {
  // Single-dollar prose/currency is intentionally conservative: numeric-leading and plain words stay raw.
  const closed = display
    ? /^\${2,}/.test(raw) &&
      /\${2,}\s*$/.test(raw) &&
      raw.trim().split("$$").length >= 3
    : raw.startsWith("$") && raw.endsWith("$");
  const admitted =
    closed &&
    safeMath(source) &&
    (display ||
      (!/^\s*\d/.test(source) &&
        /[\\=^_+*/-]/.test(source) &&
        !/^\s|\s$/.test(source)));
  return admitted ? (
    <Suspense fallback={raw}>
      <LazyMath source={source} raw={raw} display={display} />
    </Suspense>
  ) : (
    <>{raw}</>
  );
}
