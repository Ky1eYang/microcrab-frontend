import { lazy, Suspense } from "react";
import { safeMath } from "./policy";
const LazyMath = lazy(() =>
  import("./math-engine").catch(() => ({
    default: ({ raw }: { source: string; raw: string; display: boolean }) => (
      <span className="notranslate" translate="no">
        {raw}
      </span>
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
  const isDisplay = display || (/^\${2,}/.test(raw) && /\${2,}\s*$/.test(raw));
  const trimmed = source.trim();
  const closed = isDisplay
    ? /^\${2,}/.test(raw) &&
      /\${2,}\s*$/.test(raw) &&
      raw.trim().split("$$").length >= 3
    : raw.startsWith("$") && raw.endsWith("$");
  const validSingle =
    !isDisplay &&
    (source.includes("\\") ||
      (!/^\s*\d/.test(source) &&
        /[\\=^_+*/-]/.test(source) &&
        !/^\s|\s$/.test(source)));
  const admitted = closed && safeMath(trimmed) && (isDisplay || validSingle);
  return admitted ? (
    <Suspense
      fallback={
        <span className="notranslate" translate="no">
          {raw}
        </span>
      }
    >
      <LazyMath source={trimmed} raw={raw} display={isDisplay} />
    </Suspense>
  ) : (
    <span className="notranslate" translate="no">
      {raw}
    </span>
  );
}
