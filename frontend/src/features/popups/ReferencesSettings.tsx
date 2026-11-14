import { useEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { t } from "../../i18n";
import {
  validateReferences,
  type ReferenceSource,
  type ReferencesSnapshot,
} from "../../client/settings";

/** Persist sources separately from the explicit refresh of the selected live Session. */
export function ReferencesSettings({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const [snapshot, setSnapshot] = useState<ReferencesSnapshot | null>(null);
  const [sources, setSources] = useState<ReferenceSource[]>([]);
  const [type, setType] = useState<ReferenceSource["type"]>("host_path");
  const [path, setPath] = useState("");
  const [root, setRoot] = useState(".");
  const [pattern, setPattern] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const generation = useRef(0);
  const identity = JSON.stringify([
    state.authSession?.principal?.owner,
    projectId,
  ]);
  const matches = state.sessions.some(
    (session) =>
      session.id === state.sessionId && session.projectID === projectId,
  );
  const dirty =
    JSON.stringify(sources) !== JSON.stringify(snapshot?.sources ?? []);
  const request = (method: string, params = {}, sessionId?: string) =>
    dispatch({
      type: "SettingsRequest",
      method,
      params: { project_id: projectId, ...params },
      sessionId,
    });
  const load = async () => {
    const ticket = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await request("project.references.get");
      if (ticket === generation.current) {
        setSnapshot(next);
        setSources(next.sources);
      }
    } catch (failure) {
      if (ticket === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSnapshot(null);
    setSources([]);
    setPath("");
    setRoot(".");
    setPattern("");
    setUrl("");
    setStatus("");
    void load();
    return () => {
      generation.current++;
    };
  }, [identity]);
  const save = async () => {
    if (!snapshot) return;
    const ticket = generation.current;
    try {
      validateReferences({ revision: snapshot.revision, sources });
      setBusy(true);
      setError("");
      const next = await request("project.references.set", {
        expected_revision: snapshot.revision,
        sources,
      });
      if (ticket === generation.current) {
        setSnapshot(next);
        setSources(next.sources);
        setStatus(t("ownerSettings.saved"));
      }
    } catch (failure) {
      if (ticket === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const refresh = async () => {
    if (!snapshot || !state.sessionId || !matches || dirty) return;
    const ticket = generation.current;
    try {
      setBusy(true);
      setError("");
      // project_id belongs to persistence only; refresh pins the saved revision.
      await dispatch({
        type: "SettingsRequest",
        method: "session.references.refresh",
        sessionId: state.sessionId,
        params: { project_revision: snapshot.revision },
      });
      if (ticket === generation.current)
        setStatus(t("ownerSettings.referencesRefreshed"));
    } catch (failure) {
      if (ticket === generation.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (ticket === generation.current) setBusy(false);
    }
  };
  const add = () => {
    const source: ReferenceSource =
      type === "host_path"
        ? { type, path: path.trim() }
        : type === "host_glob"
          ? { type, root: root.trim() || ".", pattern: pattern.trim() }
          : { type, url: url.trim() };
    try {
      validateReferences({
        revision: snapshot?.revision ?? 0,
        sources: [...sources, source],
      });
      setSources([...sources, source]);
      setError("");
      setStatus("");
      setPath("");
      setPattern("");
      setUrl("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <section data-testid="project-references" aria-busy={busy}>
      <h4 className="project-settings-pane-title">
        {t("project.settings.refs.heading")}
      </h4>
      <p className="inline-notice">{t("ownerSettings.referencesHint")}</p>
      {error && (
        <p role="alert" className="inline-notice" data-tone="danger">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="inline-notice">
          {status}
        </p>
      )}
      <div className="project-ref-add" data-testid="project-ref-add">
        <select
          className="settings-input"
          aria-label={t("project.settings.refs.kind")}
          value={type}
          onChange={(event) =>
            setType(event.target.value as ReferenceSource["type"])
          }
        >
          {["host_path", "host_glob", "directory_url", "url"].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        {type === "host_path" && (
          <input
            className="settings-input"
            aria-label={t("project.settings.refs.path")}
            placeholder={t("project.settings.refs.path")}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        )}
        {type === "host_glob" && (
          <>
            <input
              className="settings-input"
              aria-label={t("project.settings.refs.root")}
              value={root}
              onChange={(event) => setRoot(event.target.value)}
            />
            <input
              className="settings-input"
              aria-label={t("project.settings.refs.pattern")}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
          </>
        )}
        {(type === "url" || type === "directory_url") && (
          <input
            className="settings-input"
            aria-label={t("project.settings.refs.url")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        )}
        <button
          className="ghost-btn"
          disabled={busy || !snapshot}
          onClick={add}
        >
          {t("project.settings.refs.add")}
        </button>
      </div>
      <div className="project-ref-list" data-testid="project-ref-list">
        {sources.length ? (
          sources.map((source, index) => (
            <div
              className="project-ref-row"
              key={index}
              data-testid="project-ref-row"
            >
              <span className="project-ref-kind">{source.type}</span>
              <span className="project-ref-main monospace-text">
                {"path" in source
                  ? source.path
                  : "root" in source
                    ? `${source.root} · ${source.pattern}`
                    : source.url}
              </span>
              <button
                className="ghost-btn"
                disabled={busy}
                aria-label={t("project.settings.refs.remove")}
                onClick={() =>
                  setSources(sources.filter((_, at) => at !== index))
                }
              >
                ×
              </button>
            </div>
          ))
        ) : (
          <p>{t("project.settings.refs.empty")}</p>
        )}
      </div>
      <div className="settings-actions-row">
        <button
          className="primary-btn"
          data-testid="project-ref-save"
          disabled={!snapshot || busy || !dirty}
          onClick={() => void save()}
        >
          {t("project.settings.refs.save")}
        </button>
        <button
          className="ghost-btn"
          disabled={!snapshot || busy}
          onClick={() => {
            setSources(snapshot?.sources ?? []);
            setStatus("");
          }}
        >
          {t("project.settings.refs.discard")}
        </button>
        <button
          className="ghost-btn"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("ownerSettings.reload")}
        </button>
        <button
          className="ghost-btn"
          data-testid="project-ref-refresh"
          disabled={!snapshot || !matches || busy || dirty}
          onClick={() => void refresh()}
        >
          {t("ownerSettings.refreshReferences")}
        </button>
      </div>
    </section>
  );
}
