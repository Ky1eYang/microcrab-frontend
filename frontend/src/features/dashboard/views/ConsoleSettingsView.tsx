import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  accountPreferenceSaveObserved,
  relaySelectionKey,
  type AccountPreferences,
  type DefaultConversationFlavor,
  type SaveAccountPreferences,
} from "../../../client/account-preferences";
import type { ConsoleSettingsSection } from "../../../client/dashboard-route";
import { usageRanges, type UsageRange } from "../../../client/dashboard-usage";
import { registerDocumentLeave } from "../../../client/document-leave";
import { CommandError } from "../../../client/errors";
import type { ThemePreference } from "../../../client/theme";
import { t, type LocalePreference } from "../../../i18n";
import { useAppFields, useAppStore } from "../../../state";
import { ModalContainer } from "../components/ModalContainer";
import { OwnerSettings, ProvidersSettings } from "../../popups/OwnerSettings";

const p = (key: string, params?: Record<string, string | number>) =>
  t(`accountPreferences.${key}`, params);

function draftFromPrefs(data: AccountPreferences) {
  return {
    range: data.dashboard_default_range,
    threshold: data.low_cache_hit_warn_pct?.toString() ?? "",
    relay: relaySelectionKey(data.relay_default_selection),
    flavor: data.default_conversation_flavor ?? "",
    theme: data.theme ?? "",
    locale: data.locale ?? "",
  };
}

export function ConsoleSettingsView({
  section,
  onSelectSection,
}: {
  section: ConsoleSettingsSection;
  onSelectSection: (section: ConsoleSettingsSection) => void;
}) {
  const { state } = useAppFields([
    "authSession",
    "resolvedLocale",
    "theme",
    "locale",
  ]);
  const owner = state.authSession?.authenticated
    ? state.authSession.principal?.owner
    : undefined;

  const navItems: { id: ConsoleSettingsSection; label: string }[] = [
    { id: "providers", label: t("ownerSettings.providers") },
    { id: "defaults", label: t("ownerSettings.defaults") },
    { id: "preferences", label: t("console.settings.preferences") },
  ];

  return (
    <div className="sb-view-container space-y-4">
      <div className="sb-card p-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            {t("console.nav.settings")}
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            {t("console.settings.subtitle")}
          </p>
        </div>
        <div className="sb-btn-group" role="tablist" aria-label={t("console.nav.settings")}>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              className={`sb-btn-group-item ${section === item.id ? "active" : ""}`}
              data-testid={`console-settings-tab-${item.id}`}
              onClick={() => onSelectSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {section === "providers" && (
        <div className="sb-card p-4 md:p-5">
          <ProvidersSettings key={owner} />
        </div>
      )}

      {section === "defaults" && (
        <div className="sb-card p-4 md:p-5">
          <OwnerSettings key={owner} scope={{ kind: "user" }} />
        </div>
      )}

      {section === "preferences" &&
        (owner ? (
          <AccountPreferencesPanel key={owner} owner={owner} />
        ) : (
          <div className="sb-card p-4 text-xs text-neutral-400" role="status">
            {t("usage.authRequired")}
          </div>
        ))}
    </div>
  );
}

function AccountPreferencesPanel({ owner }: { owner: string }) {
  const store = useAppStore();
  const api = store.api;
  const [snapshot, setSnapshot] = useState<AccountPreferences>();
  const [draft, setDraft] = useState<ReturnType<typeof draftFromPrefs>>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [blocked, setBlocked] = useState<"conflict" | SaveAccountPreferences>();
  const [discard, setDiscard] = useState(false);
  const continuation = useRef<() => void>(undefined);
  const operation = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  const dirty =
    !!snapshot &&
    !!draft &&
    JSON.stringify(draft) !== JSON.stringify(draftFromPrefs(snapshot));
  const protectedDraft = useRef(false);
  useLayoutEffect(() => {
    protectedDraft.current = dirty || !!blocked;
  }, [dirty, blocked]);

  useEffect(() => {
    const unregister = registerDocumentLeave(
      () => root.current,
      (proceed) => {
        if (operation.current && protectedDraft.current) return false;
        if (!protectedDraft.current) return true;
        continuation.current = proceed;
        setDiscard(true);
        return false;
      },
    );
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (protectedDraft.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  const start = () => {
    if (operation.current) return;
    const current = new AbortController();
    operation.current = current;
    setBusy(true);
    setError("");
    setStatus("");
    return current;
  };
  const finish = (current: AbortController) => {
    if (operation.current === current) {
      operation.current = null;
      setBusy(false);
    }
  };

  async function load(reconcile?: typeof blocked) {
    const current = start();
    if (!current) return;
    try {
      const data = await api.readAccountPreferences(owner, current.signal);
      if (current.signal.aborted) return;
      setSnapshot(data);
      store.dispatch({ type: "SetAccountPreferences", value: data });
      if (
        !reconcile ||
        (reconcile !== "conflict" && accountPreferenceSaveObserved(data, reconcile))
      ) {
        setDraft(draftFromPrefs(data));
        if (reconcile) setStatus(p("saved"));
      } else {
        setDraft(draftFromPrefs(data));
        setStatus(p(reconcile === "conflict" ? "reloaded" : "unconfirmed"));
      }
      setBlocked(undefined);
    } catch (failure) {
      if (!current.signal.aborted) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      finish(current);
    }
  }

  useLayoutEffect(() => {
    void load();
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [api, owner]);

  async function save() {
    if (!snapshot || !draft || !dirty || blocked) return;
    const trimmedThreshold = draft.threshold.trim();
    const warnPct = trimmedThreshold === "" ? null : Number(trimmedThreshold);
    if (
      warnPct !== null &&
      (!Number.isInteger(warnPct) || warnPct < 1 || warnPct > 99)
    ) {
      setError(p("thresholdRange"));
      return;
    }
    const models = [...snapshot.relay_models, snapshot.relay_default_selection];
    const selected = models.find((m) => draft.relay === relaySelectionKey(m));
    if (draft.relay && !selected) {
      setError(p("routeUnavailable"));
      return;
    }
    const current = start();
    if (!current) return;
    const payload: SaveAccountPreferences = {
      expected_revision: snapshot.revision,
      operation_id: crypto.randomUUID(),
      dashboard_default_range: draft.range as UsageRange,
      low_cache_hit_warn_pct: warnPct,
      relay_default_selection: selected ?? null,
      default_conversation_flavor: (draft.flavor || null) as DefaultConversationFlavor | null,
      theme: (draft.theme || null) as ThemePreference | null,
      locale: (draft.locale || null) as LocalePreference | null,
    };
    try {
      const saved = await api.saveAccountPreferences(owner, payload, current.signal);
      if (current.signal.aborted) return;
      setSnapshot(saved);
      setDraft(draftFromPrefs(saved));
      store.dispatch({ type: "SetAccountPreferences", value: saved });
      if (saved.theme) {
        await store.dispatch({ type: "SetTheme", value: saved.theme });
      }
      if (saved.locale) {
        await store.dispatch({ type: "SetLocale", value: saved.locale });
      }
      setStatus(p("saved"));
    } catch (failure) {
      if (current.signal.aborted) return;
      if (failure instanceof CommandError && failure.code === "revision_conflict") {
        setBlocked("conflict");
      } else if (failure instanceof CommandError && failure.outcomeUnknown) {
        setBlocked(payload);
      }
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      finish(current);
    }
  }

  return (
    <div ref={root} className="sb-card p-4 md:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dash-line pb-3">
        <div>
          <h3 className="text-xs font-semibold text-neutral-200">
            {t("console.settings.preferences")}
          </h3>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            {p("description")}
          </p>
        </div>
        {snapshot && (
          <span className="font-mono text-[11px] text-neutral-500">
            rev {snapshot.revision}
          </span>
        )}
      </div>

      {error && (
        <div className="settings-feedback-banner" role="alert">
          {error}
        </div>
      )}
      {status && (
        <div className="sb-toast-inline" role="status">
          {status}
        </div>
      )}

      {draft ? (
        <form
          className="space-y-4 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-range`}>
                {p("defaultRange")}
              </label>
              <select
                id={`${id}-range`}
                className="sb-select w-full"
                disabled={busy}
                value={draft.range}
                onChange={(e) =>
                  setDraft({ ...draft, range: e.currentTarget.value as UsageRange })
                }
              >
                {usageRanges.map((r) => (
                  <option key={r} value={r}>
                    {t(`console.range.${r}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-warn`}>
                {p("cacheWarnPct")}
              </label>
              <input
                id={`${id}-warn`}
                type="number"
                min={1}
                max={99}
                step={1}
                className="sb-input w-full"
                disabled={busy}
                placeholder={p("cacheWarnPlaceholder")}
                value={draft.threshold}
                onChange={(e) =>
                  setDraft({ ...draft, threshold: e.currentTarget.value })
                }
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-relay`}>
                {p("relayDefaultModel")}
              </label>
              <select
                id={`${id}-relay`}
                className="sb-select w-full"
                disabled={busy}
                value={draft.relay}
                onChange={(e) => setDraft({ ...draft, relay: e.currentTarget.value })}
              >
                <option value="">{p("relayNone")}</option>
                {snapshot?.relay_models.map((item) => {
                  const key = relaySelectionKey(item);
                  return (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  );
                })}
                {snapshot?.relay_default_selection &&
                  !snapshot.relay_models.some(
                    (m) =>
                      relaySelectionKey(m) ===
                      relaySelectionKey(snapshot.relay_default_selection),
                  ) && (
                    <option value={relaySelectionKey(snapshot.relay_default_selection)}>
                      {relaySelectionKey(snapshot.relay_default_selection)} ({p("unavailable")})
                    </option>
                  )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-flavor`}>
                {p("defaultConversationFlavor")}
              </label>
              <select
                id={`${id}-flavor`}
                className="sb-select w-full"
                disabled={busy}
                value={draft.flavor}
                onChange={(e) => setDraft({ ...draft, flavor: e.currentTarget.value })}
              >
                <option value="">{p("flavorInherit")}</option>
                <option value="chat_only">{t("home.picker.chatOnly")}</option>
                <option value="browser_sandbox">{t("home.picker.browserSandbox")}</option>
                <option value="project">{p("flavorProject")}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-theme`}>
                {t("settingsDlg.themeMode")}
              </label>
              <select
                id={`${id}-theme`}
                className="sb-select w-full"
                disabled={busy}
                value={draft.theme}
                onChange={(e) => setDraft({ ...draft, theme: e.currentTarget.value })}
              >
                <option value="">{p("deviceLocal")}</option>
                <option value="system">{t("settingsDlg.theme.system")}</option>
                <option value="light">{t("settingsDlg.theme.light")}</option>
                <option value="dark">{t("settingsDlg.theme.dark")}</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-neutral-400 font-medium" htmlFor={`${id}-locale`}>
                {t("app.settings.locale")}
              </label>
              <select
                id={`${id}-locale`}
                className="sb-select w-full"
                disabled={busy}
                value={draft.locale}
                onChange={(e) => setDraft({ ...draft, locale: e.currentTarget.value })}
              >
                <option value="">{p("deviceLocal")}</option>
                <option value="system">{t("app.settings.locale.system")}</option>
                <option value="zh-CN">{t("app.settings.locale.zh")}</option>
                <option value="en">{t("app.settings.locale.en")}</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-dash-line">
            {blocked && (
              <button
                type="button"
                className="sb-btn sb-btn-secondary"
                disabled={busy}
                onClick={() => void load(blocked)}
              >
                {p("reload")}
              </button>
            )}
            <button
              type="button"
              className="sb-btn sb-btn-ghost"
              disabled={busy || !dirty}
              onClick={() => snapshot && setDraft(draftFromPrefs(snapshot))}
            >
              {t("settingsDlg.reset")}
            </button>
            <button
              type="submit"
              className="sb-btn sb-btn-primary"
              data-testid="preferences-save"
              disabled={busy || !dirty || !!blocked}
            >
              {t("settingsDlg.save")}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-neutral-500" role="status">
          {t("console.loading")}
        </p>
      )}

      <ModalContainer
        isOpen={discard}
        onClose={() => setDiscard(false)}
        title={p("discardTitle")}
        maxWidth="max-w-sm"
        footer={
          <>
            <button
              type="button"
              className="sb-btn sb-btn-secondary"
              onClick={() => setDiscard(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="sb-btn sb-btn-danger"
              onClick={() => {
                setDiscard(false);
                continuation.current?.();
              }}
            >
              {p("discardConfirm")}
            </button>
          </>
        }
      >
        <p className="text-xs text-neutral-300 leading-relaxed">{p("discardBody")}</p>
      </ModalContainer>
    </div>
  );
}
