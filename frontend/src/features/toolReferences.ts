import type { ToolPresentation } from "../client/types";
import { t } from "../i18n";
import {
  formatJson,
  RICH_TEXT_LIMIT,
  sourceText,
} from "./content-inspection/format";
import { referenceLabels, type ReferenceKind } from "./referenceLabels";

type Path = readonly (string | number)[];
type Slot = (path: Path) => ReferenceKind | "internal-image" | undefined;
type Direction = "arguments" | "result";

function isFileVersion(path: Path, direction: Direction) {
  if (direction === "arguments")
    return (
      (path.length === 1 && path[0] === "expected_version") ||
      (path.length === 4 &&
        path[0] === "preconditions" &&
        typeof path[1] === "number" &&
        path[2] === "expected" &&
        path[3] === "version")
    );
  return (
    (path.length === 1 && path[0] === "version") ||
    (path.length === 4 &&
      path[0] === "receipts" &&
      typeof path[1] === "number" &&
      path[2] === "outcome" &&
      path[3] === "version")
  );
}

/** Project only certified scalar slots. Preserve all unrelated string/number
 * lexemes, order, and provider/guest content. Undefined means use source as-is. */
export function projectReferenceSlots(value: unknown, slot: Slot) {
  const source = sourceText(value);
  if (!source || source.length > RICH_TEXT_LIMIT) return undefined;
  const kinds = new Map<ReferenceKind, string[]>();
  let synthetic = false;
  try {
    formatJson(source, (path, lexeme) => {
      const kind = slot(path);
      if (!kind) return lexeme;
      const exact = JSON.parse(lexeme) as string;
      if (kind === "internal-image") {
        synthetic ||= legacyImageSource(exact);
      } else {
        const values = kinds.get(kind) ?? [];
        values.push(exact);
        kinds.set(kind, values);
      }
      return lexeme;
    });
    if (!kinds.size && !synthetic) return undefined;
    const labels = new Map(
      [...kinds].map(([kind, values]) => [kind, referenceLabels(kind, values)]),
    );
    let changed = false;
    const display = formatJson(source, (path, lexeme) => {
      const kind = slot(path);
      if (!kind) return lexeme;
      const exact = JSON.parse(lexeme) as string;
      const label =
        kind === "internal-image"
          ? legacyImageSource(exact)
            ? t("references.internalImage")
            : exact
          : labels.get(kind)!(exact);
      if (label === exact) return lexeme;
      changed = true;
      return JSON.stringify(label);
    });
    return changed ? { display, synthetic, preservesJsonNodes: true } : undefined;
  } catch {
    return undefined;
  }
}

export function legacyImageSource(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:file|bytes|inline|https):[0-9a-f]{64}(?![\s\S])/.test(value)
  );
}

export function toolReferenceProjection(
  value: unknown,
  presentation: ToolPresentation | undefined,
  direction: Direction,
  parent?: string,
) {
  if (!presentation) return undefined;
  return projectReferenceSlots(value, (sourcePath) => {
    if (parent !== undefined && sourcePath[0] !== parent) return undefined;
    const path = parent === undefined ? sourcePath : sourcePath.slice(1);
    if (presentation === "coding-file" && isFileVersion(path, direction))
      return "digest";
    if (path.length !== 1) return undefined;
    if (
      direction === "result" &&
      presentation === "message-receipt" &&
      path[0] === "operation_id"
    )
      return "message";
    if (
      direction === "arguments" &&
      presentation === "plugin-artifact" &&
      path[0] === "artifact"
    )
      return "digest";
    return undefined;
  });
}
