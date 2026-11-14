import { Fragment, type ReactNode } from "react";
import { t } from "../i18n";
import { Markdown } from "../features/views";
import { Payload } from "../features/Payload";
import type { EditDiagnostic } from "../features/content-inspection/ContentViewer";
import { Icon } from "../shell/Icon";
import { PluginWebview, type PluginWebviewScope } from "./PluginWebview";
import "./webview.css";
import { resolvePath } from "./schema";
import {
  LIMITS,
  type Bound,
  type Json,
  type PluginNode,
  type PluginView,
  type Vars,
} from "./types";
export interface PluginRendererProps {
  view: PluginView;
  onAction: (action: string, payload?: Json) => void;
  onEditAction?: (
    action: string,
    text: string,
    context: Json,
    statePath: string,
  ) => Promise<void>;
  onValidateAction?: (
    action: string,
    text: string,
    context: Json,
    statePath: string,
  ) => Promise<EditDiagnostic[]>;
  onObserveAction?: (action: string, statePath: string) => Promise<void>;
  onVariable: (path: string, value: Json) => void;
  webviewScope?: PluginWebviewScope;
  visible?: boolean;
}
function bound<T>(value: Bound<T> | undefined, vars: Vars): T | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "$ref" in value
  )
    return resolvePath(vars, String(value.$ref)) as T | undefined;
  return value as T | undefined;
}
const string = (value: unknown) =>
  typeof value === "string"
    ? value
    : value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
/** Schema-only interpreter. Structural trees are cached by the registry, never by plugin identity. */
export function PluginRenderer({
  view,
  onAction,
  onEditAction,
  onObserveAction,
  onValidateAction,
  onVariable,
  webviewScope,
  visible = true,
}: PluginRendererProps) {
  let count = 0;
  const node = (
    n: PluginNode,
    vars: Vars,
    path: string,
    depth: number,
    aliases: Record<string, string> = {},
  ): ReactNode => {
    if (depth > LIMITS.depth) return null;
    const p = n.props ?? {},
      get = <T,>(v: Bound<T> | undefined) => bound(v, vars);
    if (get(p.visible) === false) return null;
    if (++count > LIMITS.nodes) return null;
    const text = string(get(p.text)),
      label = string(get(p.label)),
      value =
        p.value === undefined && p.bind
          ? resolvePath(vars, p.bind)
          : get(p.value),
      disabled = get(p.disabled) === true;
    const children = () =>
      n.children?.map((child, i) => (
        <Fragment key={child.id ?? i}>
          {node(child, vars, `${path}.${i}`, depth + 1, aliases)}
        </Fragment>
      ));
    const sourcePath = (binding: string) => {
      const normalized = binding.replace(/^\$\.?/, "");
      const first = normalized.split(".")[0]!;
      return aliases[first]
        ? aliases[first] + normalized.slice(first.length)
        : normalized;
    };
    const change = (next: Json) => {
      if (p.bind) onVariable(sourcePath(p.bind), next);
      if (p.change_action) onAction(p.change_action, { value: next });
    };
    const actionPayload = () =>
      p.action_payload === undefined
        ? { value: value ?? null }
        : (get(p.action_payload) ?? null);
    const action = () => {
      if (!disabled && p.action) onAction(p.action, actionPayload());
    };
    const resolvedIcon = get(p.icon);
    const iconName =
      typeof resolvedIcon === "string"
        ? resolvedIcon
        : (p.icon as string | undefined);
    const icon = iconName ? (
      <Icon name={iconName} size={16} aria-hidden="true" />
    ) : null;
    switch (n.type) {
      case "conditional":
        return get(p.test) ? children() : null;
      case "repeat": {
        const items = get(p.items);
        if (!Array.isArray(items)) return null;
        return items.slice(0, LIMITS.nodes).map((item, index) => {
          const alias = p.as ?? "item",
            local = { ...vars, [alias]: item, index };
          const nextAliases = { ...aliases };
          if (
            p.items &&
            typeof p.items === "object" &&
            !Array.isArray(p.items) &&
            "$ref" in p.items &&
            typeof p.items.$ref === "string"
          )
            nextAliases[alias] = `${sourcePath(p.items.$ref)}.${index}`;
          return (
            <Fragment
              key={
                item &&
                typeof item === "object" &&
                !Array.isArray(item) &&
                typeof item.id === "string"
                  ? item.id
                  : index
              }
            >
              {n.children?.map((child, i) => (
                <Fragment key={child.id ?? i}>
                  {node(
                    child,
                    local,
                    `${path}.${index}.${i}`,
                    depth + 1,
                    nextAliases,
                  )}
                </Fragment>
              ))}
            </Fragment>
          );
        });
      }
      case "column":
      case "row":
        return (
          <div className={`plugin-node-${n.type}`} data-plugin-node={n.id}>
            {children()}
          </div>
        );
      case "text":
        return (
          <span className="plugin-node-text">
            {text}
            {children()}
          </span>
        );
      case "notice":
        return (
          <div
            className="plugin-node-notice"
            data-tone={p.tone ?? "info"}
            role={p.tone === "error" ? "alert" : "status"}
          >
            {text}
            {children()}
          </div>
        );
      case "button": {
        const pressed = Boolean(get(p.pressed));
        const hasPressed = p.pressed !== undefined;
        return (
          <button
            type="button"
            className={`ghost-btn plugin-node-button${pressed ? " active" : ""}`}
            disabled={disabled}
            onClick={action}
            aria-label={label || text || undefined}
            title={label || undefined}
            aria-pressed={hasPressed ? pressed : undefined}
            data-pressed={hasPressed ? (pressed ? "true" : "false") : undefined}
          >
            {icon}
            {text || (!icon ? label : "")}
            {children()}
          </button>
        );
      }
      case "textarea": {
        const placeholder = string(get(p.placeholder));
        return (
          <label className="plugin-node-field">
            {label && <span>{label}</span>}
            <textarea
              className="settings-input plugin-node-textarea"
              data-testid="plugin-node-textarea"
              data-plugin-node={n.id}
              name={p.bind}
              rows={p.rows ?? 8}
              disabled={disabled}
              value={string(value)}
              placeholder={placeholder}
              aria-label={label || placeholder || p.bind || undefined}
              onChange={(event) => change(event.target.value)}
            />
          </label>
        );
      }
      case "input": {
        const placeholder = string(get(p.placeholder));
        return (
          <label className="plugin-node-field">
            {label && <span>{label}</span>}
            <span
              className="plugin-node-input-wrap"
              data-clear={p.clear_action ? "true" : undefined}
            >
              <input
                className="settings-input"
                name={p.bind}
                type={p.input_type ?? "text"}
                disabled={disabled}
                value={string(value)}
                placeholder={placeholder}
                aria-label={label || placeholder || undefined}
                onChange={(event) =>
                  change(
                    p.input_type === "number" &&
                      event.target.value !== "" &&
                      Number.isFinite(event.target.valueAsNumber)
                      ? event.target.valueAsNumber
                      : event.target.value,
                  )
                }
              />
              {p.clear_action && (
                <button
                  type="button"
                  className="ghost-btn plugin-node-input-clear"
                  disabled={disabled || !string(value)}
                  aria-label={string(get(p.clear_label))}
                  title={string(get(p.clear_label))}
                  style={{ visibility: string(value) ? "visible" : "hidden" }}
                  onClick={() => {
                    if (!disabled) onAction(p.clear_action!, { value: "" });
                  }}
                >
                  <Icon name="close" size={14} aria-hidden="true" />
                </button>
              )}
            </span>
          </label>
        );
      }
      case "select":
        return (
          <label className="plugin-node-field">
            {label && <span>{label}</span>}
            <select
              className="settings-input"
              name={p.bind}
              disabled={disabled}
              value={string(value)}
              aria-label={label || undefined}
              onChange={(event) => change(event.target.value)}
            >
              {p.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      case "tabs":
        return (
          <div
            className="plugin-node-tabs"
            role="tablist"
            aria-label={label || undefined}
          >
            {p.options?.map((option) => (
              <button
                key={option.value}
                className="ghost-btn"
                type="button"
                role="tab"
                disabled={disabled}
                aria-selected={value === option.value}
                onClick={() => change(option.value)}
              >
                {option.label}
              </button>
            ))}
            {children()}
          </div>
        );
      case "form":
        return (
          <form
            className="plugin-node-column"
            onSubmit={(event) => {
              event.preventDefault();
              if (!disabled && p.action) {
                if (p.action_payload !== undefined) {
                  onAction(p.action, actionPayload());
                  return;
                }
                const data: Record<string, Json> = {};
                new FormData(event.currentTarget).forEach((v, k) => {
                  if (typeof v === "string") data[k] = v;
                });
                onAction(p.action, { ...data, value: value ?? null });
              }
            }}
          >
            {children()}
          </form>
        );
      case "payload":
        return (
          <div className="plugin-node-payload">
            <Payload
              value={value ?? text}
              label={label || undefined}
              variant="inspector"
              documentId={`${view.pluginId}:${view.surface?.surface_id ?? ""}:${path}:${view.instanceGeneration ?? ""}:${view.historyGeneration ?? ""}`}
              allowedFormats={p.allowed_formats}
              editNotice={get(p.edit_notice)}
              onValidateEdit={
                p.edit_validate_action &&
                p.edit_validation_state &&
                onValidateAction &&
                !disabled
                  ? (text, context) =>
                      onValidateAction(
                        p.edit_validate_action!,
                        text,
                        context as Json,
                        sourcePath(p.edit_validation_state!.$ref),
                      )
                  : undefined
              }
              editValue={get(p.edit_value)}
              editContext={get(p.edit_context)}
              onObserve={
                p.edit_observe_action &&
                onObserveAction &&
                p.edit_state &&
                ["unknown", "queued"].includes(
                  String(
                    (get(p.edit_state) as { status?: string } | undefined)
                      ?.status,
                  ),
                )
                  ? () =>
                      onObserveAction(
                        p.edit_observe_action!,
                        sourcePath(p.edit_state!.$ref),
                      )
                  : undefined
              }
              onEdit={
                p.edit_action && p.edit_state && onEditAction && !disabled
                  ? (text, context) =>
                      onEditAction(
                        p.edit_action!,
                        text,
                        context as Json,
                        sourcePath(p.edit_state!.$ref),
                      )
                  : undefined
              }
            />
          </div>
        );
      case "markdown":
        return (
          <div className="plugin-node-markdown">
            <Markdown text={text} allowImages={false} />
          </div>
        );
    }
  };
  if (view.error || (view.mode === "native-json" && view.tree === null))
    return null;
  return (
    <div
      className="plugin-renderer"
      data-plugin-id={view.pluginId}
      data-target={view.target}
      data-status={view.status}
    >
      {view.mode === "webview-html" ? (
        webviewScope ? (
          <PluginWebview
            view={view}
            scope={webviewScope}
            visible={visible}
            onAction={onAction}
          />
        ) : (
          <p
            className="plugin-webview-error"
            role="alert"
            data-testid="plugin-webview-error"
            data-reason="missing-scope"
          >
            {t("plugins.webview.error.missing-scope")}
          </p>
        )
      ) : view.tree ? (
        node(view.tree, view.vars, "root", 0)
      ) : null}
    </div>
  );
}
