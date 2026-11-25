import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { JsonReaderSource } from "./content-inspection/JsonValueView";
import { CodeText } from "./content-inspection/CodeText";
import {
  ContentViewer,
  type ContentEditorProps,
} from "./content-inspection/ContentViewer";
import {
  presentContent,
  sourceText,
  type ContentFormat,
} from "./content-inspection/format";
import { Icon } from "./shared";
import { t } from "../i18n";
import { ContentDialog, useInContentDialog } from "./ContentDialog";
/** Payload bodies taller than this collapse behind 展开全部. */
export const PAYLOAD_COLLAPSE_PX = 320;

/**
 * The one renderer for tool arguments and results, in the chat and in the
 * trajectory inspector. Flat: an optional label row, plain mono text, a copy
 * button and, for long bodies, a 展开全部 / 收起 toggle. It never draws a box
 * of its own because it always sits inside a container.
 */
export function Payload({
  label,
  value,
  projection,
  testid,
  empty,
  status,
  fillBody = false,
  variant = "default",
  dialogTitle,
  expanded,
  onExpandedChange,
  onEdit,
  editValue,
  editContext,
  documentId,
  onObserve,
  allowedFormats,
  editDiagnostics,
  onValidateEdit,
  editNotice,
  defaultFormat = "auto",
}: ContentEditorProps & {
  onObserve?: () => Promise<void>;
  defaultFormat?: ContentFormat;
  label?: string;
  value: unknown;
  /** Display-only source; exact evidence remains the existing value. */
  projection?: { display: string; synthetic?: boolean; preservesJsonNodes?: boolean };
  testid?: string;
  empty?: string;
  status?: string;
  /** Use the height allocated by the surrounding scroll region instead of 320px. */
  fillBody?: boolean;
  /** Trajectory details scroll without folding; other callers retain show-all. */
  variant?: "default" | "trajectory" | "inspector";
  dialogTitle?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const inDialog = useInContentDialog();
  const scroll = variant !== "default" || inDialog;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [exactSource, setExactSource] = useState<string>();
  const evidence = useMemo(() => sourceText(value), [value]);
  const canShowExact = Boolean(projection && !projection.synthetic);
  const showExact = exactSource === evidence && canShowExact;
  const source = useMemo(
    () => (!showExact && projection ? projection.display : evidence),
    [evidence, projection, showExact],
  );
  const jsonExact: JsonReaderSource | null | undefined = projection?.synthetic
    ? null
    : typeof value !== "string" ? { kind: "value", value }
    : projection ? { kind: "text", text: evidence } : undefined;
  const format = showExact ? "raw" : defaultFormat;
  const presentation = useMemo(
    () => presentContent(source, format),
    [source, format],
  );
  const { text } = presentation;
  const json = presentation.kind === "json";
  const fullControls = inDialog || variant === "inspector";
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [localOpen, setOpen] = useState(false);
  const open = expanded ?? localOpen;
  const [tall, setTall] = useState(false);
  const container = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLPreElement>(null);
  const bodyId = useId();
  useLayoutEffect(() => {
    if (scroll) return;
    const el = body.current;
    const root = container.current;
    if (!el || !root) return;
    const measure = () => {
      // The root keeps its allocated height even while expanded. Do not deduct
      // the toggle: otherwise its appearance could change the overflow decision.
      const labelHeight = label
        ? (heading.current?.getBoundingClientRect().height ?? 20) + 2
        : 0;
      const limit = fillBody
        ? Math.max(0, root.clientHeight - labelHeight)
        : PAYLOAD_COLLAPSE_PX;
      setTall(el.scrollHeight > limit + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (fillBody) observer.observe(root);
    return () => observer.disconnect();
  }, [text, fillBody, label, scroll]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!fullControls && !onEdit && (!text || (!scroll && text === "{}")))
    return empty ? <div className="payload-empty">{empty}</div> : null;
  const collapsed = !scroll && tall && !open;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };
  const exactLabel = t(showExact ? "references.compact" : "references.exact");
  const toggleExact = () => {
    setExactSource(showExact ? undefined : evidence);
    setCopied(false);
    setCopyFailed(false);
  };
  const exactToggle = canShowExact && (
    <button
      type="button"
      className="payload-exact"
      data-testid="payload-exact-toggle"
      aria-pressed={showExact}
      aria-label={exactLabel}
      title={exactLabel}
      onClick={toggleExact}
    >
      <Icon name="file-code" size={12} aria-hidden="true" focusable="false" />
    </button>
  );
  return (
    <>
      <section
        ref={container}
        className="payload"
        data-variant={
          variant === "inspector"
            ? "inspector"
            : scroll
              ? "trajectory"
              : undefined
        }
        data-fill-body={fillBody ? "true" : undefined}
        data-testid={testid}
        data-format={json ? "json" : "text"}
        data-collapsed={collapsed ? "true" : "false"}
        data-labelled={label ? "true" : "false"}
        data-status={status}
      >
        {fullControls ? (
          <>
            {label && (
              <div className="payload-head">
                <span className="payload-label">{label}</span>
              </div>
            )}
            <ContentViewer
              key={showExact ? "exact" : "formatted"}
              source={source}
              serialized={!projection && typeof value !== "string"}
              defaultFormat={format}
              exactEvidence={showExact}
              onToggleExact={canShowExact ? toggleExact : undefined}
              jsonExact={jsonExact}
              matchProjectedNodes={!projection || projection.preservesJsonNodes}
              title={label ?? dialogTitle}
              onEdit={onEdit}
              editValue={editValue}
              editContext={editContext}
              documentId={documentId}
              onObserve={onObserve}
              allowedFormats={showExact ? ["raw"] : allowedFormats}
              editDiagnostics={editDiagnostics}
              onValidateEdit={onValidateEdit}
              editNotice={editNotice}
            />
          </>
        ) : (
          <>
            <div ref={heading} className="payload-head">
              {label && <span className="payload-label">{label}</span>}
              <div className="payload-actions">
                {exactToggle}
                <button
                  type="button"
                  className="payload-copy"
                  aria-label={copied ? t("content.copied") : t(showExact ? "references.copyExact" : "content.copy")}
                  title={copied ? t("content.copied") : t(showExact ? "references.copyExact" : "content.copy")}
                  onClick={() => void copy()}
                >
                  <Icon name={copied ? "check" : "copy"} size={12} />
                </button>
                {(scroll || onEdit || (open && json)) && !inDialog && (
                  <button
                    type="button"
                    className="payload-dialog-expand"
                    data-testid="payload-dialog-expand"
                    aria-label={t("content.expand")}
                    title={t("content.expand")}
                    onClick={() => setDialogOpen(true)}
                  >
                    <Icon name="expand" size={12} />
                  </button>
                )}
              </div>
            </div>
            {copyFailed && (
              <div className="content-viewer-feedback">
                <span role="alert">{t("contentViewer.copyFailed")}</span>
              </div>
            )}
            <pre
              ref={body}
              id={bodyId}
              className="payload-body"
              tabIndex={scroll ? 0 : undefined}
              aria-label={
                scroll
                  ? (label ?? dialogTitle ?? t("content.title"))
                  : undefined
              }
            >
              <CodeText
                text={text}
                kind={
                  presentation.kind === "markdown" ? "raw" : presentation.kind
                }
              />
            </pre>
            {!scroll && tall && (
              <button
                type="button"
                className="payload-expand"
                data-testid="payload-expand"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => (onExpandedChange ?? setOpen)(!open)}
              >
                {t(open ? "common.collapse" : "payload.showAll")}
              </button>
            )}
          </>
        )}
      </section>
      {dialogOpen && !inDialog && (
        <ContentDialog
          maximizable
          title={dialogTitle ?? label ?? t("content.title")}
          onClose={() => setDialogOpen(false)}
        >
          <Payload
            value={value}
            projection={projection}
            label={label}
            status={status}
            variant="trajectory"
            onEdit={onEdit}
            editValue={editValue}
            editContext={editContext}
            documentId={documentId}
            defaultFormat={defaultFormat}
            onObserve={onObserve}
            allowedFormats={allowedFormats}
            editDiagnostics={editDiagnostics}
            onValidateEdit={onValidateEdit}
            editNotice={editNotice}
          />
        </ContentDialog>
      )}
    </>
  );
}
