import "../../styles/prompt-settings.css";
import { lazy, Suspense, useState } from "react";
import {
  PROMPT_FIELDS,
  type PromptField,
  type SettingsOverrides,
  type SettingsSnapshot,
} from "../../client/settings";
import { t } from "../../i18n";

const SourceEditor = lazy(() => import("../content-inspection/SourceEditor"));

function PromptSetting({
  field,
  value,
  snapshot,
  busy,
  onChange,
}: {
  field: PromptField;
  value: string | null | undefined;
  snapshot: SettingsSnapshot;
  busy: boolean;
  onChange: (field: PromptField, value: string | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const mode =
    editing || (value != null && value !== "")
      ? "custom"
      : value === ""
        ? "empty"
        : "inherit";
  const hint = `promptSettings.hint.${field}`;
  const label = t(`promptSettings.${field}`);
  const source = snapshot.sources[field];
  return (
    <div className="prompt-setting" data-testid={`prompt-setting-${field}`}>
      <label className="settings-form-label" htmlFor={`prompt-mode-${field}`}>
        {label}
      </label>
      <select
        id={`prompt-mode-${field}`}
        className="settings-input"
        disabled={busy}
        value={mode}
        data-testid={`prompt-mode-${field}`}
        onChange={(event) => {
          const selected = event.target.value;
          setEditing(selected === "custom");
          onChange(
            field,
            selected === "inherit"
              ? undefined
              : selected === "empty"
                ? ""
                : (value ?? ""),
          );
        }}
      >
        <option value="inherit">{t("ownerSettings.inherit")}</option>
        <option value="empty">
          {t(
            field === "client_prompt"
              ? "promptSettings.disable"
              : "promptSettings.baseline",
          )}
        </option>
        <option value="custom">{t("promptSettings.custom")}</option>
      </select>
      <p className="settings-description" id={`prompt-hint-${field}`}>
        {t(hint)}
      </p>
      {source && (
        <p className="settings-row-sub">
          {t("promptSettings.source", {
            source: t(`ownerSettings.source.${source}`),
          })}
        </p>
      )}
      {mode === "custom" && (
        <>
          <div
            className="prompt-editor"
            aria-describedby={`prompt-hint-${field}`}
          >
            <Suspense
              fallback={<p role="status">{t("contentViewer.editorLoading")}</p>}
            >
              <SourceEditor
                key={`${field}-${snapshot.revision}`}
                text={value ?? ""}
                promptField={field}
                json={false}
                wrap
                lineNumbers
                disabled={busy}
                autoFocus={false}
                label={label}
                diagnostics={[]}
                onChange={(text) => onChange(field, text)}
              />
            </Suspense>
          </div>
          <p className="settings-description">
            {t(
              value === ""
                ? field === "client_prompt"
                  ? "promptSettings.emptyClient"
                  : "promptSettings.emptyTemplate"
                : "promptSettings.literalBytes",
            )}
          </p>
        </>
      )}
    </div>
  );
}

export function PromptSettings({
  draft,
  snapshot,
  busy,
  frozen,
  onChange,
}: {
  draft: SettingsOverrides;
  snapshot: SettingsSnapshot;
  busy: boolean;
  frozen: boolean;
  onChange: (field: PromptField, value: string | undefined) => void;
}) {
  return (
    <section className="settings-section-card" data-testid="prompt-settings">
      <div className="settings-section-head">
        <h4 className="settings-section-title">{t("promptSettings.title")}</h4>
      </div>
      <p className="settings-description" data-testid="prompt-settings-timing">
        {t(frozen ? "promptSettings.frozen" : "promptSettings.newSessions")}
      </p>
      {!frozen && (
        <>
          <p className="settings-description">
            {t("promptSettings.inheritance")}
          </p>
          {PROMPT_FIELDS.map((field) => (
            <PromptSetting
              key={`${field}-${snapshot.revision}`}
              field={field}
              value={draft[field]}
              snapshot={snapshot}
              busy={busy}
              onChange={onChange}
            />
          ))}
        </>
      )}
    </section>
  );
}
