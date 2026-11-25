import { useEffect, useId, useState, type ReactNode } from "react";
import { t, type ResolvedLocale } from "../../i18n";
import { Icon } from "../shared";
import { scanJson } from "./json-lexemes";
import {
  copyJsonNode,
  readChildren,
  stringWindow,
  type JsonDocument,
  type JsonNode,
} from "./json-reader-source";

type Path = readonly (string | number)[];
type DisplayString = (path: Path, text: string) => string;
const RANGE = 100;
const MAX_TREE_DEPTH = 8;
const PREVIEW_POINTS = 300;
const CHUNK_POINTS = 1200;
const punctuation = (text: string) => (
  <span className="json-punctuation">{text}</span>
);

export type InspectorCopy = (
  id: number,
  getValue: (signal: AbortSignal) => Promise<string>,
) => void;

type Props = {
  document: JsonDocument;
  exactDocument: JsonDocument | null;
  /** A certified projection that preserves keys, order and node kinds. */
  matchProjectedNodes?: boolean;
  displayString?: DisplayString;
  copy: InspectorCopy;
  copied?: number;
  locale?: ResolvedLocale;
  open: number[];
  toggle: (id: number) => void;
};

export function ObjectInspector(props: Props) {
  const { document, exactDocument, matchProjectedNodes } = props;
  return (
    <ul
      role="list"
      className="json-inspector"
      data-testid="object-inspector"
      translate="no"
    >
      <NodeRow
        {...props}
        node={document.root}
        exact={exactDocument?.root}
        scopedExact={exactDocument === document || !!matchProjectedNodes}
        path={[]}
        depth={0}
      />
    </ul>
  );
}

type RowProps = Props & {
  node: JsonNode;
  exact?: JsonNode;
  scopedExact: boolean;
  path: Path;
  depth: number;
};

function NodeRow(props: RowProps) {
  const {
    document,
    exactDocument,
    node,
    exact,
    path,
    open,
    toggle,
    displayString,
    copy,
    copied,
    locale,
  } = props;
  const id = useId();
  const expanded = open.includes(node.start);
  const isContainer = node.kind === "array" || node.kind === "object";
  const isString = node.kind === "string";
  const isArray = node.kind === "array";
  const string = isString
    ? stringWindow(document.text, node.start + 1, node.end - 1, PREVIEW_POINTS)
    : undefined;
  // Certified transforms consume only bounded complete strings, not clipped data.
  const visibleString =
    string && string.end === node.end - 1 && displayString
      ? displayString(path, string.text)
      : string?.text;
  const clipped = string && string.end < node.end - 1;
  const depthLimited =
    isContainer && node.count > 0 && props.depth >= MAX_TREE_DEPTH;
  const canExpand = isContainer ? node.count > 0 && !depthLimited : !!clipped;
  const key =
    node.key &&
    stringWindow(document.text, node.key.start + 1, node.key.end - 1, 80);
  const keyLabel = key
    ? key.end === node.key!.end - 1
      ? key.text
      : `${key.text}…`
    : path.at(-1);
  const bare =
    typeof keyLabel === "number" ||
    (typeof keyLabel === "string" &&
      /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(keyLabel));
  const label =
    keyLabel === undefined
      ? t("objectInspector.root", undefined, locale)
      : String(keyLabel);
  const scalar = document.text.slice(
    node.start,
    Math.min(node.end, node.start + PREVIEW_POINTS),
  );
  const summarized = expanded
    ? undefined
    : depthLimited
      ? t("objectInspector.depthLimit", undefined, locale)
      : !isArray && isContainer && node.count > 0
        ? objectSummary(document.text, node, locale)
        : t("objectInspector.items", { count: String(node.count) }, locale);
  return (
    <li data-testid="json-node">
      <div className="json-row">
        {canExpand ? (
          <button
            type="button"
            className="json-icon-button json-disclosure"
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={t(
              expanded ? "objectInspector.collapse" : "objectInspector.expand",
              { value: label },
              locale,
            )}
            onClick={() => toggle(node.start)}
          >
            <Icon name="chevron" size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className="json-icon-spacer" />
        )}
        <code className="json-row-value">
          {keyLabel !== undefined && (
            <>
              <span className="json-key">
                {bare ? keyLabel : JSON.stringify(keyLabel)}
              </span>
              {punctuation(": ")}
            </>
          )}
          {isContainer ? (
            <>
              {punctuation(isArray ? "[" : "{")}
              {node.count > 0 && !expanded && (
                <>
                  {" "}
                  <span className="json-summary">{summarized}</span>{" "}
                </>
              )}
              {(!expanded || node.count === 0) &&
                punctuation(isArray ? "]" : "}")}
            </>
          ) : isString ? (
            <>
              {clipped ? (
                <StringChunks
                  id={id}
                  expanded={expanded}
                  preview={visibleString ?? ""}
                  text={document.text}
                  start={node.start + 1}
                  end={node.end - 1}
                  locale={locale}
                />
              ) : (
                <span className="json-string">
                  {punctuation('"')}
                  {visibleString}
                  {punctuation('"')}
                </span>
              )}
            </>
          ) : (
            <span className="json-literal">
              {scalar}
              {node.end - node.start > PREVIEW_POINTS && punctuation("…")}
            </span>
          )}
        </code>
        {exact && exactDocument && (
          <button
            type="button"
            data-testid="json-copy-node"
            className="json-icon-button json-row-copy"
            data-copied={copied === node.start || undefined}
            aria-label={t(
              "objectInspector.copyNamed",
              { value: label },
              locale,
            )}
            title={t("objectInspector.copyExact", undefined, locale)}
            onClick={() =>
              copy(node.start, (signal) =>
                copyJsonNode(exactDocument, exact, signal),
              )
            }
          >
            <Icon
              name={copied === node.start ? "check" : "copy"}
              size={14}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {canExpand && isContainer && (
        <div id={id} hidden={!expanded}>
          {expanded && <Branch {...props} />}
        </div>
      )}
    </li>
  );
}

function Branch(props: RowProps) {
  const {
    document,
    node,
    exact,
    exactDocument,
    scopedExact,
    path,
    open,
    locale,
  } = props;
  const [page, setPage] = useState(0);
  const from = page * RANGE;
  const to = Math.min(from + RANGE, node.count);
  const [result, setResult] = useState<{
    page: number;
    rows: JsonNode[];
    exactRows?: JsonNode[];
  }>();
  const [errorPage, setErrorPage] = useState<number>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const rows = await readChildren(
          document,
          node,
          from,
          to,
          controller.signal,
        );
        const exactRows =
          scopedExact &&
          exact &&
          exactDocument &&
          exact.kind === node.kind &&
          exact.count === node.count
            ? exactDocument === document
              ? rows
              : await readChildren(
                  exactDocument,
                  exact,
                  from,
                  to,
                  controller.signal,
                )
            : undefined;
        if (!controller.signal.aborted) setResult({ page, rows, exactRows });
      } catch {
        if (!controller.signal.aborted) setErrorPage(page);
      }
    })();
    return () => controller.abort();
  }, [document, node, exact, exactDocument, scopedExact, from, to, page]);
  const isArray = node.kind === "array";
  return (
    <div className="json-branch">
      {node.count > RANGE && (
        <div className="json-range">
          <button
            type="button"
            className="json-control"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t("objectInspector.previous", undefined, locale)}
          </button>
          <span>
            {t(
              "objectInspector.range",
              {
                first: String(from + 1),
                last: String(to),
                total: String(node.count),
              },
              locale,
            )}
          </span>
          <button
            type="button"
            className="json-control"
            disabled={to === node.count}
            onClick={() => setPage(page + 1)}
          >
            {t("objectInspector.next", undefined, locale)}
          </button>
        </div>
      )}
      {errorPage === page ? (
        <p role="status">
          {t("objectInspector.unavailable", undefined, locale)}
        </p>
      ) : result?.page !== page ? (
        <p role="status">{t("objectInspector.loading", undefined, locale)}</p>
      ) : (
        <ul role="list">
          {result.rows.map((child, index) => {
            const exactChild = result.exactRows?.[index];
            const key =
              child.key &&
              stringWindow(
                document.text,
                child.key.start + 1,
                child.key.end - 1,
                80,
              );
            // A very large key is still copyable by value, but cannot act as a
            // certified display-transform path derived from a clipped key.
            const part = isArray
              ? child.ordinal
              : key && key.end === child.key!.end - 1
                ? key.text
                : undefined;
            const canBind =
              exactChild &&
              child.kind === exactChild.kind &&
              (!child.key ||
                (exactChild.key &&
                  exactDocument &&
                  (exactDocument === document ||
                    (key &&
                      key.end === child.key.end - 1 &&
                      key.text ===
                        stringWindow(
                          exactDocument.text,
                          exactChild.key.start + 1,
                          exactChild.key.end - 1,
                          81,
                        ).text))));
            return (
              <NodeRow
                {...props}
                key={child.start}
                node={child}
                depth={props.depth + 1}
                exact={canBind ? exactChild : undefined}
                path={part === undefined ? path : [...path, part]}
                displayString={
                  part === undefined ? undefined : props.displayString
                }
                open={open}
              />
            );
          })}
        </ul>
      )}
      <code>{punctuation(isArray ? "]" : "}")}</code>
    </div>
  );
}

function objectSummary(text: string, node: JsonNode, locale?: ResolvedLocale) {
  const names: string[] = [];
  let depth = 0;
  try {
    for (const event of scanJson(
      text,
      node.start,
      Math.min(node.end, node.start + 160),
    )) {
      if (event.kind === "object" || event.kind === "array") depth++;
      if (event.kind === "endObject" || event.kind === "endArray") depth--;
      if (event.kind !== "key" || depth !== 1) continue;
      const key = stringWindow(text, event.start + 1, event.end - 1, 18);
      const label =
        key.text.replace(/\s+/g, " ") + (key.end < event.end - 1 ? "…" : "");
      names.push(label || '""');
      if (names.length === 2) break;
    }
  } catch {
    /* This intentionally bounded prefix may end inside a token. */
  }
  return names.length
    ? `${names.join(", ")}${names.length < node.count ? ", …" : ""}`
    : t("objectInspector.members", { count: String(node.count) }, locale);
}

function StringChunks({
  id,
  expanded,
  preview,
  text,
  start,
  end,
  locale,
}: {
  id: string;
  expanded: boolean;
  preview: string;
  text: string;
  start: number;
  end: number;
  locale?: ResolvedLocale;
}) {
  return (
    <>
      {!expanded && (
        <span className="json-string">
          {punctuation('"')}
          {preview}
          {punctuation('…"')}
        </span>
      )}
      <span id={id} hidden={!expanded}>
        {expanded && (
          <StringPage text={text} start={start} end={end} locale={locale} />
        )}
      </span>
    </>
  );
}

function StringPage({
  text,
  start,
  end,
  locale,
}: {
  text: string;
  start: number;
  end: number;
  locale?: ResolvedLocale;
}) {
  const [offset, setOffset] = useState(start);
  const chunk = stringWindow(text, offset, end, CHUNK_POINTS);
  let controls: ReactNode;
  if (chunk.end < end || offset !== start) {
    controls = (
      <span className="json-range json-string-pages">
        <button
          type="button"
          className="json-control"
          disabled={offset === start}
          onClick={() => setOffset(start)}
        >
          {t("objectInspector.firstChunk", undefined, locale)}
        </button>
        <button
          type="button"
          className="json-control"
          disabled={chunk.end === end}
          onClick={() => setOffset(chunk.end)}
        >
          {t("objectInspector.nextChunk", undefined, locale)}
        </button>
      </span>
    );
  }
  return (
    <>
      <span className="json-string">
        {punctuation(offset === start ? '"' : '"…')}
        {chunk.text}
        {punctuation(chunk.end < end ? '…"' : '"')}
      </span>
      {controls}
    </>
  );
}
