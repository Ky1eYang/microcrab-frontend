import katex from "katex";
import "katex/dist/katex.min.css";
import { useMemo } from "react";
/** This module and its local font assets have no synchronous entry import. */
export default function MathEngine({
  source,
  raw,
  display,
}: {
  source: string;
  raw: string;
  display: boolean;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(source, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: "error",
        maxExpand: 100,
        maxSize: 10,
        output: "htmlAndMathml",
        macros: {},
      });
    } catch {
      return null;
    }
  }, [source, display]);
  return html ? (
    <span
      className="visual-math notranslate"
      translate="no"
      data-testid="math-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <span className="notranslate" translate="no">
      {raw}
    </span>
  );
}
