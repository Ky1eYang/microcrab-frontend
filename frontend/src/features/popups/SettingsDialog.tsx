import { OwnerSettings, ProvidersSettings } from "./OwnerSettings";
import {
  browserHostOrigins,
  resetBrowserHostOrigins,
  saveBrowserHostOrigins,
} from "../../client/browser-host";
import { useApp } from "../../state";
import { Icon } from "../shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThemePreference } from "../../client/theme";
import type { LocalePreference } from "../../i18n";
import { t } from "../../i18n";
import { trapFocus } from "../../client/viewport";
import { unsupported } from "../../client/unsupported";
import type { ReactNode } from "react";
import { ModelRetrySettings } from "./ModelRetrySettings";
import { ClientToolsSettings } from "../ClientToolsSettings";

const THEME_OPTIONS: [ThemePreference, string][] = [
  ["light", "settingsDlg.theme.light"],
  ["dark", "settingsDlg.theme.dark"],
  ["system", "settingsDlg.theme.system"],
];

/** Three-way theme picker following the WAI-ARIA radio group pattern. */
function ThemeRadioGroup({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const next = (from + step + THEME_OPTIONS.length) % THEME_OPTIONS.length;
    onChange(THEME_OPTIONS[next][0]);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={t("settingsDlg.themeMode")}
      data-testid="theme-options"
    >
      {THEME_OPTIONS.map(([option, label], index) => (
        <button
          key={option}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          className="segmented-option"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          data-testid={`theme-option-${option}`}
          onClick={() => onChange(option)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

const LOCALE_OPTIONS: [LocalePreference, string][] = [
  ["zh-CN", "app.settings.locale.zh"],
  ["en", "app.settings.locale.en"],
  ["system", "app.settings.locale.system"],
];

function LocaleRadioGroup({
  value,
  onChange,
}: {
  value: LocalePreference;
  onChange: (value: LocalePreference) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, step: number) => {
    const next = (from + step + LOCALE_OPTIONS.length) % LOCALE_OPTIONS.length;
    onChange(LOCALE_OPTIONS[next][0]);
    refs.current[next]?.focus();
  };
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label={t("app.settings.locale")}
      data-testid="locale-options"
    >
      {LOCALE_OPTIONS.map(([option, key], index) => (
        <button
          key={option}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="radio"
          className="segmented-option"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          data-testid={`locale-option-${option}`}
          aria-label={`${t("app.settings.locale")}${t("common.fieldSep")}${t(key)}`}
          onClick={() => onChange(option)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            }
          }}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

function Row({
  label,
  sub,
  children,
  mono = false,
}: {
  label: string;
  sub: ReactNode;
  children?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{label}</div>
        <div className={`settings-row-sub${mono ? " monospace-text" : ""}`}>
          {sub}
        </div>
      </div>
      {children && <div className="settings-row-action">{children}</div>}
    </div>
  );
}
export function SettingsDialog() {
  const { state, dispatch } = useApp(),
    p = state.popup;
  const [apiUrlInput, setApiUrlInput] = useState(state.apiBase);
  const [statusMessage, setStatusMessage] = useState("");
  const [browserNetworkError, setBrowserNetworkError] = useState("");
  const browserOriginsInput = useRef<HTMLTextAreaElement>(null);
  const networkOwner = state.authSession?.principal?.owner ?? "";
  const [browserOrigins, setBrowserOrigins] = useState(() => {
    try {
      return browserHostOrigins(state.apiBase, networkOwner)?.join("\n") ?? "";
    } catch {
      return "";
    }
  });
  const [browserNetworkDefault, setBrowserNetworkDefault] = useState(() => {
    try {
      return browserHostOrigins(state.apiBase, networkOwner) === null;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      const origins = browserHostOrigins(state.apiBase, networkOwner);
      setBrowserOrigins(origins?.join("\n") ?? "");
      setBrowserNetworkDefault(origins === null);
    } catch {
      setBrowserOrigins("");
      setBrowserNetworkDefault(false);
    }
  }, [state.apiBase, networkOwner]);
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // Every section starts at the top instead of inheriting the previous one's
  // scroll position.
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [p.tab]);
  // Esc closes the dialog; on close, focus returns to whatever opened it (the
  // user card button when the menu item that opened it is gone).
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Capture phase: the dialog is the top layer, so it handles Esc and Tab
    // before the narrow drawer underneath it.
    const onKey = (event: KeyboardEvent) => {
      // A portaled nested dialog owns both Escape and its focus trap. An open
      // combobox owns its first Escape, even before this capture listener.
      const nested = [
        ...document.querySelectorAll<HTMLElement>(
          'dialog[open], [role="dialog"][aria-modal="true"]',
        ),
      ].some(
        (node) => node !== dialog.current && node.getClientRects().length > 0,
      );
      if (nested) return;
      if (
        event.key === "Escape" &&
        event.target instanceof Element &&
        event.target.closest('[role="combobox"][aria-expanded="true"]')
      )
        return;
      if (event.key === "Tab") {
        event.stopPropagation();
        trapFocus(dialog.current, event);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "DismissPopup" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const target =
        opener && opener.isConnected && opener !== document.body
          ? opener
          : [...document.querySelectorAll<HTMLElement>(".user-card-btn")].find(
              (el) => el.offsetParent !== null,
            );
      target?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const emit = (type: string, value?: unknown) => {
    if (type === "SetSettingsApiUrl") {
      setApiUrlInput(String(value));
      setStatusMessage("");
      return;
    }
    if (type === "SaveSettingsApiBase") {
      try {
        // TODO: Map server switching to the native Cookie-authenticated transport.
        unsupported(t("settingsDlg.unsupportedSwitch"));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setStatusMessage(text);
        void dispatch({ type: "ShowToast", text, kind: "warn" });
      }
      return;
    }
    return dispatch({ type, value });
  };
  const tabs = [
    ["providers", t("ownerSettings.providers"), t("ownerSettings.providers")],
    ["defaults", t("ownerSettings.defaults"), t("ownerSettings.defaults")],
    ["session-config", t("ownerSettings.session"), t("ownerSettings.session")],
    [
      "backend",
      t("settingsDlg.tab.backend"),
      t("settingsDlg.tab.backendTitle"),
    ],
    [
      "client-tools",
      t("clientTools.title"),
      t("settingsDlg.tab.clientToolsTitle"),
    ],
    [
      "appearance",
      t("settingsDlg.tab.appearance"),
      t("settingsDlg.tab.appearanceTitle"),
    ],
    [
      "account",
      t("settingsDlg.tab.account"),
      t("settingsDlg.tab.accountTitle"),
    ],
    [
      "storage",
      t("settingsDlg.tab.storage"),
      t("settingsDlg.tab.storageTitle"),
    ],
    ["about", t("settingsDlg.tab.about"), t("settingsDlg.tab.about")],
  ];
  const navIcon = (tab: string) => (
    <svg
      className="settings-nav-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {tab === "backend" ? (
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      ) : tab === "appearance" ? (
        <>
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C22 6.5 17.5 2 12 2z" />
        </>
      ) : tab === "account" ? (
        <>
          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </>
      ) : tab === "storage" ? (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </>
      )}
    </svg>
  );
  return (
    <div className="overlay">
      <div
        className="settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("settingsDlg.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-title">{t("settingsDlg.title")}</div>
          {[
            [0, 6, t("settingsDlg.group.system")],
            [6, 8, t("settingsDlg.group.data")],
          ].map(([start, end, title]) => (
            <div className="settings-nav-group" key={String(title)}>
              <div className="settings-nav-group-label">{title}</div>
              {tabs.slice(Number(start), Number(end)).map(([id, label]) => (
                <button
                  className="settings-nav-item"
                  data-active={p.tab === id}
                  key={id}
                  onClick={() => emit("SetSettingsTab", id)}
                >
                  {navIcon(id)}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <section className="settings-content-wrapper">
          <div className="settings-header">
            <h3 className="settings-tab-heading">
              {tabs.find((t) => t[0] === p.tab)?.[2]}
            </h3>
            <button
              className="settings-close-btn"
              title={t("settingsDlg.close")}
              aria-label={t("settingsDlg.close")}
              onClick={() => emit("DismissPopup")}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="settings-body" ref={body}>
            <div className="settings-tab-pane">
              {p.tab === "providers" && (
                <ProvidersSettings key={networkOwner} />
              )}
              {p.tab === "defaults" && <OwnerSettings key={networkOwner} />}
              {p.tab === "session-config" &&
                (state.sessionId ? (
                  <OwnerSettings
                    key={`${networkOwner}:${state.sessionId}`}
                    scope={{ kind: "session", id: state.sessionId }}
                  />
                ) : (
                  <p className="inline-notice">
                    {t("ownerSettings.selectSession")}
                  </p>
                ))}
              {p.tab === "backend" && (
                <>
                  <p className="settings-description">
                    {t("settingsDlg.backendIntro")}
                  </p>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.serviceStatus")}
                    </div>
                    <Row
                      label={t("settingsDlg.connectionState")}
                      sub={t("settingsDlg.connectionSub")}
                    >
                      <span
                        className={`badge ${state.connection === "disconnected" ? "badge-danger" : "badge-success"}`}
                      >
                        <Icon
                          name="dot"
                          size={10}
                          className="badge-dot"
                          aria-hidden="true"
                        />
                        {state.connection === "disconnected"
                          ? t("host.status.detached")
                          : state.connection === "ws"
                            ? t("settingsDlg.wsOk")
                            : t("settingsDlg.connected")}
                      </span>
                    </Row>
                    <Row label={t("settingsDlg.apiBase")} sub={state.apiBase} />
                    <Row
                      label={t("settingsDlg.identity")}
                      sub={
                        state.authSession?.principal?.display_name ??
                        t("settingsDlg.signedOut")
                      }
                    >
                      {state.authSession?.authenticated && (
                        <button
                          className="ghost-btn"
                          onClick={() => emit("Logout")}
                        >
                          {t("settingsDlg.logout")}
                        </button>
                      )}
                    </Row>
                    <div className="settings-actions-row">
                      <button
                        className="ghost-btn"
                        onClick={() => emit("Reconnect")}
                      >
                        {t("settingsDlg.reconnect")}
                      </button>
                      <button
                        className="ghost-btn"
                        onClick={() => emit("ProbeHealth")}
                      >
                        {t("settingsDlg.probe")}
                      </button>
                    </div>
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("browserHost.networkTitle")}
                    </div>
                    <div className="settings-form-group">
                      <label
                        className="settings-form-label"
                        htmlFor="browser-host-origins"
                      >
                        {t("browserHost.networkOrigins")}
                      </label>
                      <div className="settings-input-hint" role="status">
                        {t(
                          browserNetworkDefault
                            ? "browserHost.networkDefaultActive"
                            : "browserHost.networkRestrictedActive",
                        )}
                      </div>
                      <textarea
                        id="browser-host-origins"
                        ref={browserOriginsInput}
                        aria-invalid={browserNetworkError ? true : undefined}
                        aria-describedby={
                          browserNetworkError
                            ? "browser-host-origins-error"
                            : undefined
                        }
                        className="settings-input"
                        rows={3}
                        value={browserOrigins}
                        onChange={(event) => {
                          setBrowserNetworkError("");
                          setBrowserOrigins(event.target.value);
                        }}
                      />
                      {browserNetworkError && (
                        <p
                          id="browser-host-origins-error"
                          role="alert"
                          className="settings-field-error"
                        >
                          {browserNetworkError}
                        </p>
                      )}
                      <div className="settings-input-hint">
                        {t("browserHost.networkHelp")}
                      </div>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => {
                          try {
                            saveBrowserHostOrigins(
                              state.apiBase,
                              networkOwner,
                              browserOrigins,
                            );
                            setBrowserNetworkDefault(false);
                            setBrowserNetworkError("");
                            setStatusMessage(t("browserHost.networkSaved"));
                          } catch (error) {
                            const message =
                              error instanceof Error
                                ? error.message
                                : String(error);
                            setBrowserNetworkError(message);
                            browserOriginsInput.current?.focus({
                              preventScroll: true,
                            });
                            browserOriginsInput.current?.scrollIntoView({
                              block: "center",
                            });
                          }
                        }}
                      >
                        {t("browserHost.networkSave")}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => {
                          try {
                            resetBrowserHostOrigins(
                              state.apiBase,
                              networkOwner,
                            );
                            setBrowserOrigins("");
                            setBrowserNetworkDefault(true);
                            setStatusMessage(t("browserHost.networkSaved"));
                          } catch (error) {
                            setStatusMessage(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          }
                        }}
                      >
                        {t("browserHost.networkReset")}
                      </button>
                    </div>
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.addressConfig")}
                    </div>
                    <div className="settings-form-group">
                      <label className="settings-form-label" htmlFor="api-url">
                        {t("settingsDlg.apiUrl")}
                      </label>
                      <div className="settings-port-input-row">
                        <input
                          id="api-url"
                          className="settings-input"
                          type="text"
                          placeholder="http://127.0.0.1:4096/"
                          value={apiUrlInput}
                          onChange={(e) =>
                            emit("SetSettingsApiUrl", e.target.value)
                          }
                        />
                        <div className="preset-buttons">
                          {[4096, 4108, 8000].map((port) => (
                            <button
                              className="preset-btn"
                              type="button"
                              key={port}
                              onClick={() =>
                                emit(
                                  "SetSettingsApiUrl",
                                  `http://127.0.0.1:${port}/`,
                                )
                              }
                            >
                              {port === 4096
                                ? t("settingsDlg.defaultPort")
                                : port}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="settings-input-hint">
                        {t("settingsDlg.sameOrigin")}
                      </div>
                      <label className="settings-form-label" htmlFor="api-key">
                        API key
                      </label>
                      <input
                        id="api-key"
                        className="settings-input"
                        type="password"
                        placeholder={t("settingsDlg.apiKeyPlaceholder")}
                        value=""
                        disabled
                      />
                    </div>
                    {statusMessage && (
                      <div className="settings-feedback-banner">
                        {statusMessage}
                      </div>
                    )}
                    <div className="settings-actions-row">
                      <button
                        className="ghost-btn"
                        type="button"
                        onClick={() =>
                          emit("SetSettingsApiUrl", "http://127.0.0.1:4096/")
                        }
                      >
                        {t("settingsDlg.reset")}
                      </button>
                      <button
                        className="primary-btn"
                        type="button"
                        onClick={() => emit("SaveSettingsApiBase")}
                      >
                        {t("settingsDlg.save")}
                      </button>
                    </div>
                  </div>
                  <div className="settings-tip-box">
                    <div className="tip-title">
                      <Icon name="info" size={14} aria-hidden="true" />
                      {t("settingsDlg.corsTitle")}
                    </div>
                    <div className="tip-content">
                      {t("settingsDlg.corsBody")}
                    </div>
                  </div>
                </>
              )}
              {p.tab === "client-tools" && <ClientToolsSettings />}
              {p.tab === "appearance" && (
                <>
                  <p className="settings-description">
                    {t("settingsDlg.appearanceIntro")}
                  </p>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.colorTheme")}
                    </div>
                    <Row
                      label={t("settingsDlg.themeMode")}
                      sub={
                        state.resolvedTheme === "dark"
                          ? t("settingsDlg.nowDark")
                          : t("settingsDlg.nowLight")
                      }
                    >
                      <ThemeRadioGroup
                        value={state.theme}
                        onChange={(theme) => emit("SetTheme", theme)}
                      />
                    </Row>
                    <Row
                      label={t("app.settings.locale")}
                      sub={t("app.settings.locale.sub")}
                    >
                      <LocaleRadioGroup
                        value={state.locale}
                        onChange={(locale) => emit("SetLocale", locale)}
                      />
                    </Row>
                  </div>
                  <ModelRetrySettings />
                </>
              )}
              {p.tab === "account" && (
                <>
                  <p className="settings-description">
                    {t("settingsDlg.accountIntro")}
                  </p>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.clientId")}
                    </div>
                    <Row
                      label={t("settingsDlg.browserIdentity")}
                      sub={
                        state.authSession?.principal?.display_name ??
                        t("settingsDlg.signedOut")
                      }
                      mono
                    />
                    <Row label="Client Kind" sub="web (microcrab)" />
                  </div>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.sessionStats")}
                    </div>
                    <Row
                      label={t("settingsDlg.loadedSessions")}
                      sub={t("settingsDlg.sessionCount", {
                        count: state.sessions.length,
                      })}
                    />
                    <Row
                      label={t("settingsDlg.activeSession")}
                      sub={state.sessionId ?? t("settingsDlg.noActive")}
                      mono
                    />
                  </div>
                </>
              )}
              {p.tab === "storage" && (
                <>
                  <p className="settings-description">
                    {t("settingsDlg.storageIntro")}
                  </p>
                  <div className="settings-card">
                    <div className="settings-card-title">
                      {t("settingsDlg.localCache")}
                    </div>
                    <Row
                      label={t("settingsDlg.storageItems")}
                      sub={t("settingsDlg.storageSub")}
                    />
                  </div>
                </>
              )}
              {p.tab === "about" && (
                <>
                  <div className="about-brand-section">
                    <div className="about-logo">microcrab</div>
                    <div className="about-tagline">Local Agent Runtime</div>
                    <div className="about-version">
                      {t("settingsDlg.version", {
                        version:
                          state.board.version ||
                          t("settingsDlg.versionMissing"),
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
