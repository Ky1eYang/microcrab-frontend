import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../../i18n";
import { Icon } from "../shared";
import { registerDocumentLeave } from "../../client/document-leave";
import { JsonValueView, JsonViewModes, type JsonViewMode, type JsonReaderSource } from "./JsonValueView";
import { jsonValueStart } from "./json-reader-source";
import { CodeText } from "./CodeText";
import { ContentCloseGuardContext } from "./close-guard";
import {
  CONTENT_FORMATS,
  presentContent,
  RICH_TEXT_LIMIT,
  sourceText,
  type ContentFormat,
} from "./format";
import type { EditDiagnostic } from "./diagnostics";
export type { EditDiagnostic } from "./diagnostics";

const MarkdownPreview = lazy(() => import("./MarkdownPreview"));
const SourceEditor = lazy(() => import("./SourceEditor"));
const NO_DIAGNOSTICS: EditDiagnostic[] = [];
export type ContentEditorProps = {
  onEdit?: (nextText: string, context: unknown) => Promise<void>;
  editValue?: unknown;
  editContext?: unknown;
  documentId?: string;
  onObserve?: () => Promise<void>;
  allowedFormats?: ContentFormat[];
  editDiagnostics?: EditDiagnostic[];
  onValidateEdit?: (
    text: string,
    context: unknown,
  ) => Promise<EditDiagnostic[]>;
  editNotice?: string;
};
type Props = ContentEditorProps & {
  source: string;
  serialized?: boolean;
  exactEvidence?: boolean;
  onToggleExact?: () => void;
  jsonExact?: JsonReaderSource | null;
  matchProjectedNodes?: boolean;
  defaultFormat?: ContentFormat;
  title?: string;
  controls?: boolean;
};
type Draft = { text: string; initial: string; context: unknown };
const reason = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

export function ContentViewer(props: Props) {
  return <DocumentViewer key={props.documentId ?? "content"} {...props} />;
}

function DocumentViewer({
  source,
  serialized,
  exactEvidence = false,
  onToggleExact,
  jsonExact,
  matchProjectedNodes,
  defaultFormat = "auto",
  title,
  onEdit,
  editValue,
  editContext,
  onObserve,
  allowedFormats,
  editDiagnostics = NO_DIAGNOSTICS,
  onValidateEdit,
  editNotice,
  controls = true,
}: Props) {
  const formats = allowedFormats?.length ? allowedFormats : CONTENT_FORMATS;
  const [mode, setMode] = useState<ContentFormat>(
    formats.includes(defaultFormat) ? defaultFormat : formats[0],
  );
  const effectiveMode = formats.includes(mode) ? mode : formats[0];
  const [wrap, setWrap] = useState(true);
  const [lineNumbers, setLineNumbers] = useState(true);
  const [jsonMode, setJsonMode] = useState<JsonViewMode>("text");
  const jsonExactKind = jsonExact?.kind;
  const jsonExactValue = jsonExact?.kind === "text" ? jsonExact.text : jsonExact?.value;
  const exact = useMemo(() => jsonExact, [jsonExactKind, jsonExactValue, jsonExact === null]);
  const [view, setView] = useState({ source, exact, matchProjectedNodes, paused: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [observing, setObserving] = useState(false);
  const [observedSaved, setObservedSaved] = useState(false);
  const [failure, setFailure] = useState("");
  const [copyState, setCopyState] = useState<"" | "copied" | "copyFailed">("");
  const [discard, setDiscard] = useState(false);
  const [validated, setValidated] = useState<{
    draft: Draft;
    items: EditDiagnostic[];
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const registerGuard = useContext(ContentCloseGuardContext);
  const root = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDetailsElement>(null);
  const reading = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const continuation = useRef<(() => void) | undefined>(undefined);
  const latestDraft = useRef(draft);
  const validateEdit = useRef(onValidateEdit);
  validateEdit.current = onValidateEdit;
  latestDraft.current = draft;
  const changed = view.source !== source || view.exact !== exact || view.matchProjectedNodes !== matchProjectedNodes;
  if (!view.paused && changed)
    setView({ source, exact, matchProjectedNodes, paused: false });
  const presentation = useMemo(
    () => presentContent(view.source, effectiveMode),
    [view.source, effectiveMode],
  );
  // Explicit JSON can defer validation to the cooperative tree. Auto only
  // offers a fallback for collection-looking text when display budgets blocked
  // recognition. Raw-only and guest format boundaries still win.
  const jsonAvailable = (formats.includes("json") || !allowedFormats) && (
    presentation.kind === "json" || presentation.jsonCandidate ||
    (presentation.notice === "large" && (effectiveMode === "json" ||
      (effectiveMode === "auto" && jsonValueStart(view.source))))
  );
  const readingMode = controls && jsonAvailable ? jsonMode : "text";
  const textReader = () => <pre className="payload-body content-viewer-pre" tabIndex={0} aria-label={title ?? t("contentViewer.document")}>
    <CodeText text={presentation.text} kind={presentation.kind === "markdown" ? "raw" : presentation.kind} lineNumbers={lineNumbers} />
  </pre>;
  const dirty = draft !== null && draft.text !== draft.initial;
  const guardState = useRef({ dirty, pending });
  guardState.current = { dirty, pending };
  useEffect(() => {
    if (!controls) return;
    const outside = (event: PointerEvent) => {
      if (
        more.current?.open &&
        event.target instanceof Node &&
        !more.current.contains(event.target)
      )
        more.current.open = false;
    };
    const details = more.current;
    const positionActions = () => {
      if (!details?.open || !root.current) return;
      const panel = details.querySelector<HTMLElement>(
        ".content-viewer-more-actions",
      );
      if (!panel) return;
      const viewport = window.visualViewport;
      let top = viewport?.offsetTop ?? 0;
      let bottom = top + (viewport?.height ?? window.innerHeight);
      let left = Math.max(
        viewport?.offsetLeft ?? 0,
        root.current.getBoundingClientRect().left,
      );
      let right = Math.min(
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
        root.current.getBoundingClientRect().right,
      );
      // Keep native Tab order in details, but fit its overlay inside each
      // clipping scroll owner rather than relying on the browser viewport alone.
      for (
        let owner = details.parentElement;
        owner;
        owner = owner.parentElement
      ) {
        const style = getComputedStyle(owner);
        const rect = owner.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, rect.top);
          bottom = Math.min(bottom, rect.bottom);
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, rect.left);
          right = Math.min(right, rect.right);
        }
      }
      const anchor = details.getBoundingClientRect();
      const below = Math.max(0, bottom - anchor.bottom);
      const above = Math.max(0, anchor.top - top);
      const upward = below < panel.scrollHeight && above > below;
      panel.style.top = upward ? "auto" : "100%";
      panel.style.bottom = upward ? "100%" : "auto";
      panel.style.maxHeight = `${upward ? above : below}px`;
      panel.style.maxWidth = `${Math.max(0, right - left)}px`;
      panel.style.insetInlineEnd = "auto";
      panel.style.left = `${Math.max(left, Math.min(anchor.right - panel.offsetWidth, right - panel.offsetWidth)) - anchor.left}px`;
    };
    document.addEventListener("pointerdown", outside, true);
    details?.addEventListener("toggle", positionActions);
    document.addEventListener("scroll", positionActions, true);
    window.addEventListener("resize", positionActions);
    window.visualViewport?.addEventListener("resize", positionActions);
    window.visualViewport?.addEventListener("scroll", positionActions);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      details?.removeEventListener("toggle", positionActions);
      document.removeEventListener("scroll", positionActions, true);
      window.removeEventListener("resize", positionActions);
      window.visualViewport?.removeEventListener("resize", positionActions);
      window.visualViewport?.removeEventListener("scroll", positionActions);
    };
  }, [controls]);
  useEffect(() => {
    if (discard)
      root.current
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="content-viewer-keepEditing"]',
        )
        ?.focus();
  }, [discard]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      continuation.current = undefined;
    };
  }, []);
  useEffect(() => {
    const guard = (proceed?: () => void) => {
      if (guardState.current.pending) return false;
      if (guardState.current.dirty) {
        continuation.current = proceed;
        setDiscard(true);
        return false;
      }
      return true;
    };
    const unregisterContext = registerGuard?.(guard);
    const unregisterDocument = registerDocumentLeave(
      () => root.current,
      guard,
      () => {
        const current = latestDraft.current;
        return current &&
          (guardState.current.dirty || guardState.current.pending)
          ? { label: title ?? t("contentViewer.dirty"), text: current.text }
          : null;
      },
    );
    return () => {
      unregisterContext?.();
      unregisterDocument();
    };
  }, [registerGuard, title]);
  useEffect(() => {
    if (!controls) return;
    const pause = () =>
      setView((current) =>
        current.paused ? current : { ...current, paused: true },
      );
    const selection = () => {
      const selected = window.getSelection();
      if (
        selected &&
        !selected.isCollapsed &&
        reading.current?.contains(selected.anchorNode)
      )
        pause();
    };
    const scroll = (event: Event) => {
      const element = event.target;
      if (
        !(element instanceof HTMLElement) ||
        !reading.current ||
        !element.contains(reading.current)
      )
        return;
      if (
        element.scrollHeight > element.clientHeight &&
        element.scrollTop + element.clientHeight < element.scrollHeight - 24
      )
        pause();
    };
    document.addEventListener("selectionchange", selection);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [controls]);
  useEffect(() => {
    if (!copyState) return;
    const timeout = setTimeout(() => setCopyState(""), 1600);
    return () => clearTimeout(timeout);
  }, [copyState]);
  useEffect(() => {
    if (!draft) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (guardState.current.dirty || guardState.current.pending)
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [Boolean(draft)]);
  useEffect(() => {
    if (!draft || !onValidateEdit) {
      setValidating(false);
      return;
    }
    let cancelled = false;
    setValidating(true);
    const timer = setTimeout(() => {
      // Validation is advisory and scoped to the captured draft, never a rebase
      // or a write. Backend save remains the final permission authority.
      void Promise.resolve()
        .then(() =>
          validateEdit.current!(draft.text, structuredClone(draft.context)),
        )
        .then((items) => {
          if (!cancelled && alive.current && latestDraft.current === draft)
            setValidated({ draft, items });
        })
        .catch((error: unknown) => {
          if (!cancelled && alive.current && latestDraft.current === draft)
            setValidated({
              draft,
              items: [{ message: reason(error), severity: "warning" }],
            });
        })
        .finally(() => {
          if (!cancelled && alive.current) setValidating(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, Boolean(onValidateEdit)]);
  const diagnostics = useMemo(
    () =>
      draft
        ? [
            ...editDiagnostics,
            ...(validated?.draft === draft ? validated.items : []),
          ]
        : NO_DIAGNOSTICS,
    [draft, editDiagnostics, validated],
  );
  const primaryDiagnostic =
    diagnostics.find((item) => item.severity === "error") ?? diagnostics[0];
  const largeDraft = draft !== null && draft.text.length > RICH_TEXT_LIMIT;
  const copy = async (original: boolean) => {
    try {
      // Draft copy is exact source, including whitespace and numeric lexemes.
      const text = draft
        ? original
          ? draft.initial
          : draft.text
        : original || presentation.kind === "markdown"
          ? view.source
          : presentation.text;
      await navigator.clipboard.writeText(text);
      if (alive.current) setCopyState("copied");
    } catch {
      if (alive.current) setCopyState("copyFailed");
    }
  };
  const startEdit = () => {
    try {
      const text =
        editValue === undefined ? view.source : sourceText(editValue);
      setDraft({ text, initial: text, context: structuredClone(editContext) });
      setFailure("");
      setValidated(null);
    } catch (error) {
      setFailure(reason(error));
    }
  };
  const changeDraft = (text: string) => {
    const current = latestDraft.current;
    if (!current) return;
    const next = { ...current, text };
    latestDraft.current = next;
    guardState.current.dirty = text !== current.initial;
    setDraft(next);
  };
  const cancel = () => {
    if (guardState.current.pending) return;
    continuation.current = undefined;
    if (guardState.current.dirty) setDiscard(true);
    else {
      setDraft(null);
      setFailure("");
    }
  };
  const save = async () => {
    const captured = latestDraft.current;
    if (!captured || !onEdit || guardState.current.pending) return;
    setObservedSaved(false);
    setPending(true);
    guardState.current.pending = true;
    setFailure("");
    try {
      await onEdit(captured.text, structuredClone(captured.context));
      if (alive.current) {
        setDraft(null);
        setDiscard(false);
        continuation.current = undefined;
      }
    } catch (error) {
      if (alive.current) setFailure(reason(error));
    } finally {
      if (alive.current) {
        setPending(false);
        guardState.current.pending = false;
      }
    }
  };
  const observe = async () => {
    if (!onObserve || observing) return;
    setObserving(true);
    setObservedSaved(false);
    try {
      await onObserve();
      if (alive.current) {
        setFailure("");
        setObservedSaved(true);
      }
    } catch (error) {
      if (alive.current) setFailure(reason(error));
    } finally {
      if (alive.current) setObserving(false);
    }
  };
  const button = (
    key: string,
    icon: string,
    click: () => void,
    pressed?: boolean,
    disabled = false,
    labelled = false,
  ) => (
    <button
      type="button"
      className="content-viewer-action"
      title={
        draft && key === "copyFormatted"
          ? t("content.copy")
          : t(`contentViewer.${key === "edit" ? "editFullSource" : key}`)
      }
      aria-label={
        draft && key === "copyFormatted"
          ? t("content.copy")
          : t(`contentViewer.${key}`)
      }
      aria-pressed={pressed}
      disabled={disabled}
      onClick={click}
      data-testid={`content-viewer-${key}`}
    >
      <Icon name={icon} size={14} aria-hidden="true" focusable="false" />
      {labelled && <span>{t(`contentViewer.${key}`)}</span>}
      {labelled && (key === "wrap" || key === "lineNumbers") && (
        <Icon
          name="check"
          className="content-viewer-action-check"
          size={14}
          aria-hidden="true"
          focusable="false"
        />
      )}
    </button>
  );
  const liveKey = view.paused
    ? changed
      ? "newContent"
      : "paused"
    : "live";
  const diagnosticText = primaryDiagnostic
    ? `${primaryDiagnostic.path ? `${primaryDiagnostic.path}: ` : ""}${primaryDiagnostic.message}`
    : "";
  // A single region has explicit priority. Lower priority facts remain discoverable
  // through controls/titles instead of accumulating several competing status bars.
  const feedback = pending
    ? t("contentViewer.saving")
    : failure ||
      (observing
        ? t("contentViewer.observing")
        : observedSaved
          ? t("contentViewer.observedSaved")
          : "") ||
      (copyState === "copyFailed" ? t("contentViewer.copyFailed") : "") ||
      diagnosticText ||
      (draft && editNotice) ||
      (copyState ? t(`contentViewer.${copyState}`) : "") ||
      (validating ? t("contentViewer.validating") : "") ||
      (!draft && presentation.error
        ? t("contentViewer.formatError", {
            format: t(`contentViewer.${effectiveMode}`),
            reason: presentation.error,
          })
        : "") ||
      (largeDraft ? t("contentViewer.large") : "") ||
      (!draft && presentation.notice
        ? t(`contentViewer.${presentation.notice}`)
        : "") ||
      (controls && view.paused ? t(`contentViewer.${liveKey}`) : "");
  const feedbackError =
    !pending &&
    Boolean(
      failure ||
      copyState === "copyFailed" ||
      primaryDiagnostic?.severity === "error" ||
      (!draft && presentation.error),
    );
  return (
    <div
      ref={root}
      className="content-viewer"
      data-testid="content-viewer"
      data-format={presentation.kind}
      data-paused={view.paused}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && more.current?.open) {
          event.stopPropagation();
          event.preventDefault();
          more.current.open = false;
          more.current
            .querySelector<HTMLElement>("summary")
            ?.focus({ preventScroll: true });
          return;
        }
        if (event.key === "Escape" && draft) {
          event.stopPropagation();
          event.preventDefault();
          cancel();
        }
      }}
    >
      {controls && (
        <div
          className="content-viewer-toolbar"
          role="group"
          aria-label={t("contentViewer.controls")}
        >
          {formats.length === 1 ? (
            <span
              className="content-viewer-format-label"
              title={serialized ? t("contentViewer.serialized") : undefined}
            >
              {t(`contentViewer.${formats[0]}`)}
            </span>
          ) : (
            <span className="content-viewer-format-choice">
              <select
                title={serialized ? t("contentViewer.serialized") : undefined}
                aria-label={t("contentViewer.format")}
                value={effectiveMode}
                onChange={(event) =>
                  setMode(event.target.value as ContentFormat)
                }
              >
                {formats.map((format) => (
                  <option key={format} value={format}>
                    {t(`contentViewer.${format}`)}
                  </option>
                ))}
              </select>
              <Icon
                name="down"
                size={12}
                aria-hidden="true"
                focusable="false"
              />
            </span>
          )}
          {!draft && jsonAvailable && <JsonViewModes mode={readingMode} onChange={setJsonMode} />}
          <div className="content-viewer-primary">
            {onToggleExact && (
              <button
                type="button"
                className="content-viewer-action"
                data-testid="content-viewer-exact"
                aria-pressed={exactEvidence}
                aria-label={t(
                  exactEvidence ? "references.compact" : "references.exact",
                )}
                title={t(
                  exactEvidence ? "references.compact" : "references.exact",
                )}
                onClick={onToggleExact}
              >
                <Icon
                  name="file-code"
                  size={14}
                  aria-hidden="true"
                  focusable="false"
                />
              </button>
            )}
            {button(
              exactEvidence ? "copyExact" : !draft && presentation.kind === "markdown"
                ? "copyMarkdown"
                : "copyFormatted",
              "copy",
              () => void copy(false),
            )}
            {onEdit && !draft && button("edit", "edit", startEdit)}
          </div>
          <details ref={more} className="content-viewer-more">
            <summary
              aria-label={t("contentViewer.more")}
              title={t("contentViewer.more")}
              data-testid="content-viewer-more"
            >
              <Icon
                name="ellipsis-vertical"
                size={14}
                aria-hidden="true"
                focusable="false"
              />
            </summary>
            <div
              className="content-viewer-more-actions"
              role="group"
              aria-label={t("contentViewer.more")}
              onClick={(event) => {
                if (
                  event.target instanceof Element &&
                  event.target.closest("button:not(:disabled)") &&
                  more.current?.open
                ) {
                  more.current.open = false;
                  more.current
                    .querySelector<HTMLElement>("summary")
                    ?.focus({ preventScroll: true });
                }
              }}
            >
              {button("wrap", "wrap", () => setWrap(!wrap), wrap, false, true)}
              {button(
                "lineNumbers",
                "line-numbers",
                () => setLineNumbers(!lineNumbers),
                lineNumbers,
                !draft && presentation.kind === "markdown",
                true,
              )}
              {button(
                view.paused ? "resume" : "pause",
                view.paused ? "play" : "pause",
                () => setView(view.paused
                  ? { source, exact, matchProjectedNodes, paused: false }
                  : { ...view, paused: true }),
                view.paused,
                false,
                true,
              )}
              {button(
                exactEvidence ? "copyExact" : serialized || view.exact !== undefined
                  ? "copySource" : "copyOriginal",
                "copy",
                () => void copy(true),
                undefined,
                false,
                true,
              )}
              {onObserve &&
                button(
                  "reconcile",
                  "refresh",
                  () => void observe(),
                  undefined,
                  observing || pending,
                  true,
                )}
            </div>
          </details>
        </div>
      )}
      {draft && (
        <div className="content-viewer-edit-bar" data-dirty={dirty}>
          <span>
            {t(dirty ? "contentViewer.dirty" : "contentViewer.editing")}
          </span>
          {button(
            "save",
            "save",
            () => void save(),
            undefined,
            pending || !onEdit,
          )}
          {button("cancel", "close", cancel, undefined, pending)}
        </div>
      )}
      <div className="content-viewer-feedback" aria-live="polite">
        {discard ? (
          <div className="content-viewer-discard" role="alert">
            <span>{t("contentViewer.discardQuestion")}</span>
            <button
              type="button"
              data-testid="content-viewer-discard"
              disabled={pending}
              onClick={() => {
                const proceed = continuation.current;
                continuation.current = undefined;
                guardState.current = { dirty: false, pending: false };
                setDraft(null);
                setDiscard(false);
                setFailure("");
                if (proceed)
                  queueMicrotask(() => {
                    if (alive.current) proceed();
                  });
              }}
            >
              {t("contentViewer.discard")}
            </button>
            <button
              type="button"
              data-testid="content-viewer-keepEditing"
              disabled={pending}
              onClick={() => {
                continuation.current = undefined;
                setDiscard(false);
                root.current
                  ?.querySelector<HTMLElement>(
                    '[data-testid="content-viewer-editor"]',
                  )
                  ?.focus();
              }}
            >
              {t("contentViewer.keepEditing")}
            </button>
          </div>
        ) : feedback ? (
          <span role={feedbackError ? "alert" : "status"}>{feedback}</span>
        ) : null}
      </div>
      {draft ? (
        largeDraft ? (
          <textarea
            className="content-viewer-editor"
            data-testid="content-viewer-editor"
            aria-label={t("contentViewer.editFullSource")}
            value={draft.text}
            spellCheck={false}
            disabled={pending}
            wrap={wrap ? "soft" : "off"}
            onChange={(event) => changeDraft(event.target.value)}
            autoFocus
          />
        ) : (
          <Suspense
            fallback={
              <div role="status">{t("contentViewer.editorLoading")}</div>
            }
          >
            <SourceEditor
              text={draft.text}
              json={
                effectiveMode === "json" ||
                (effectiveMode === "auto" && /^[\s]*[\[{]/.test(draft.initial))
              }
              wrap={wrap}
              lineNumbers={lineNumbers}
              disabled={pending}
              label={t("contentViewer.editFullSource")}
              diagnostics={diagnostics}
              onChange={changeDraft}
            />
          </Suspense>
        )
      ) : (
        <div ref={reading} className="content-viewer-reading" data-wrap={wrap}>
          {presentation.kind === "markdown" ? (
            <Suspense
              fallback={<pre className="content-viewer-pre">{view.source}</pre>}
            >
              <MarkdownPreview text={view.source} />
            </Suspense>
          ) : controls && jsonAvailable ? (
            <JsonValueView
              source={{ kind: "text", text: view.source }}
              exactSource={view.exact}
              matchProjectedNodes={view.matchProjectedNodes}
              mode={readingMode}
              hideModes
              hideRootCopy
              renderText={textReader}
            />
          ) : textReader()}
        </div>
      )}
    </div>
  );
}
