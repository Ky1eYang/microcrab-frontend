import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { t, type ResolvedLocale } from "../../i18n";
import { Icon } from "../shared";
import { CodeText } from "./CodeText";
import { formatJson, RICH_TEXT_LIMIT } from "./format";
import { ObjectInspector, type InspectorCopy } from "./ObjectInspector";
import {
  copyJsonNode,
  readerText,
  readJsonDocument,
  type JsonDocument,
  type JsonReaderSource,
} from "./json-reader-source";

export type { JsonReaderSource } from "./json-reader-source";
export type JsonViewMode = "text" | "tree";

export function JsonViewModes({
  mode,
  onChange,
  locale,
}: {
  mode: JsonViewMode;
  onChange: (value: JsonViewMode) => void;
  locale?: ResolvedLocale;
}) {
  return (
    <div
      className="json-view-modes"
      role="group"
      aria-label={t("objectInspector.presentation", undefined, locale)}
    >
      {(["text", "tree"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className="json-control"
          aria-pressed={mode === option}
          onClick={() => onChange(option)}
        >
          {t(`objectInspector.${option}`, undefined, locale)}
        </button>
      ))}
    </div>
  );
}

type Props = {
  source: JsonReaderSource;
  /** Omitted means the displayed source is also exact. Null withholds exact evidence. */
  exactSource?: JsonReaderSource | null;
  /** Opt in only for a certified string substitution that preserves key occurrences and shape. */
  matchProjectedNodes?: boolean;
  displayString?: (path: readonly (string | number)[], text: string) => string;
  scopeKey?: string;
  isCurrent?: () => boolean;
  locale?: ResolvedLocale;
  className?: string;
  renderText?: () => ReactNode;
  mode?: JsonViewMode;
  hideRootCopy?: boolean;
  hideModes?: boolean;
};

function sourceIdentity(source: JsonReaderSource | null) {
  return source?.kind === "text" ? source.text : source?.value;
}

export function JsonValueView(props: Props) {
  return <ScopedJsonValueView key={props.scopeKey} {...props} />;
}

function ScopedJsonValueView({
  source,
  exactSource = source,
  mode,
  hideModes,
  ...props
}: Props) {
  const sourceValue = sourceIdentity(source);
  const exactValue = sourceIdentity(exactSource);
  const sourceKind = source.kind;
  const exactKind = exactSource?.kind;
  const display = useMemo(() => source, [sourceKind, sourceValue]);
  const exact = useMemo(
    () =>
      exactKind === sourceKind && Object.is(exactValue, sourceValue)
        ? display
        : exactSource,
    [display, exactKind, exactValue],
  );
  const [localMode, setMode] = useState<JsonViewMode>("text");
  const effectiveMode = mode ?? localMode;
  const [bound, setBound] = useState({ display, exact, revision: 0 });
  if (bound.display !== display || bound.exact !== exact)
    setBound({ display, exact, revision: bound.revision + 1 });
  return (
    <div
      className={
        props.className
          ? `json-value-view ${props.className}`
          : "json-value-view"
      }
      data-testid="json-value-view"
    >
      {!hideModes && (
        <JsonViewModes
          mode={effectiveMode}
          onChange={setMode}
          locale={props.locale}
        />
      )}
      <SourceView
        {...props}
        key={bound.revision}
        source={display}
        exact={exact}
        mode={effectiveMode}
      />
    </div>
  );
}

function SourceView({
  source,
  exact,
  mode,
  isCurrent,
  hideRootCopy,
  renderText,
  matchProjectedNodes,
  displayString,
  locale,
}: Omit<Props, "mode"> & {
  mode: JsonViewMode;
  exact: JsonReaderSource | null;
}) {
  const [result, setResult] = useState<
    | { document: JsonDocument; exactDocument: JsonDocument | null }
    | "unavailable"
  >();
  const [branches, setBranches] = useState<number[]>();
  const [feedback, setFeedback] = useState<{ id: number; success: boolean }>();
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const scope = useRef<AbortController | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const current = useRef(isCurrent);
  useLayoutEffect(() => {
    current.current = isCurrent;
  }, [isCurrent]);
  useLayoutEffect(() => {
    const active = new AbortController();
    scope.current = active;
    return () => {
      active.abort();
      operation.current?.abort();
      clearTimeout(feedbackTimer.current);
    };
  }, []);
  useEffect(() => {
    if (mode !== "tree" || result) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      try {
        const document = await load(source, signal);
        let exactDocument = exact === source ? document : null;
        if (exact && exact !== source) {
          try {
            exactDocument = await load(exact, signal);
          } catch {
            /* Preserve the display even when the exact source is unavailable. */
          }
        }
        if (!signal.aborted) setResult({ document, exactDocument });
      } catch {
        if (!signal.aborted) setResult("unavailable");
      }
    })();
    return () => controller.abort();
  }, [mode, result, source, exact]);
  const copy: InspectorCopy = (id, getValue) => {
    const active = scope.current;
    if (!active || active.signal.aborted || current.current?.() === false)
      return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const valid = () =>
      !active.signal.aborted &&
      !controller.signal.aborted &&
      current.current?.() !== false;
    const report = (success: boolean) => {
      if (!valid()) return;
      setFeedback({ id, success });
      feedbackTimer.current = setTimeout(() => setFeedback(undefined), 1500);
    };
    clearTimeout(feedbackTimer.current);
    setFeedback(undefined);
    void (async () => {
      try {
        const value = await getValue(controller.signal);
        if (!valid()) return;
        await navigator.clipboard.writeText(value);
        report(true);
      } catch {
        report(false);
      }
    })();
  };
  return (
    <>
      {exact && !hideRootCopy && (
        <button
          className="json-control json-copy-root"
          type="button"
          data-testid="json-copy-root"
          onClick={() =>
            copy(-1, async (signal) => {
              const document =
                typeof result === "object" ? result.exactDocument : null;
              const value = document ?? (await load(exact, signal));
              return copyJsonNode(value, value.root, signal);
            })
          }
        >
          <Icon
            name={feedback?.id === -1 && feedback.success ? "check" : "copy"}
            size={14}
            aria-hidden="true"
          />
          {t("objectInspector.copyExact", undefined, locale)}
        </button>
      )}
      <div className="json-copy-feedback" aria-live="polite" aria-atomic="true">
        {feedback
          ? t(
              feedback.success
                ? "contentViewer.copied"
                : "objectInspector.copyFailed",
              undefined,
              locale,
            )
          : ""}
      </div>
      <div className="json-reading-surface" data-mode={mode}>
        {mode === "text" ? (
          (renderText?.() ?? <DefaultText source={source} locale={locale} />)
        ) : !result ? (
          <p role="status">{t("objectInspector.loading", undefined, locale)}</p>
        ) : result === "unavailable" ? (
          <p role="status">
            {t("objectInspector.unavailable", undefined, locale)}
          </p>
        ) : (
          <ObjectInspector
            {...result}
            locale={locale}
            matchProjectedNodes={matchProjectedNodes}
            displayString={displayString}
            copy={copy}
            copied={feedback?.success ? feedback.id : undefined}
            open={branches ?? [result.document.root.start]}
            toggle={(id) =>
              setBranches((open) => {
                const rootId = result.document.root.start;
                const previous = open ?? [rootId];
                return previous.includes(id)
                  ? previous.filter((openId) => openId !== id)
                  : [
                      ...previous
                        .filter((openId) => openId !== rootId)
                        .slice(-7),
                      id,
                      ...(id !== rootId && previous.includes(rootId)
                        ? [rootId]
                        : []),
                    ];
              })
            }
          />
        )}
      </div>
    </>
  );
}

async function load(source: JsonReaderSource, signal: AbortSignal) {
  return readJsonDocument(
    await readerText(source, signal),
    signal,
    source.kind === "value",
  );
}

function DefaultText({
  source,
  locale,
}: {
  source: JsonReaderSource;
  locale?: ResolvedLocale;
}) {
  const [serialized, setSerialized] = useState<string>();
  useEffect(() => {
    if (source.kind === "text") return;
    const controller = new AbortController();
    void readerText(source, controller.signal).then(
      (text) => {
        if (!controller.signal.aborted) setSerialized(text);
      },
      () => {
        if (!controller.signal.aborted) setSerialized("");
      },
    );
    return () => controller.abort();
  }, [source]);
  const text = useMemo(() => {
    const raw = source.kind === "text" ? source.text : serialized;
    if (raw === undefined || raw.length > RICH_TEXT_LIMIT) return raw;
    try {
      return formatJson(raw);
    } catch {
      return raw;
    }
  }, [source, serialized]);
  return text ? (
    <pre className="json-value-text" tabIndex={0}>
      <CodeText text={text} kind="json" />
    </pre>
  ) : (
    <p role="status">
      {t(
        text === undefined
          ? "objectInspector.loading"
          : "objectInspector.unavailable",
        undefined,
        locale,
      )}
    </p>
  );
}
