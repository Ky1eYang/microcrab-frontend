import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatLibraryBytes,
  sourceKindLabel,
  type PersonalLibraryObject,
  type PersonalLibraryShortcutTarget,
} from "../../client/library";
import type { ReferencesSnapshot } from "../../client/settings";
import { t } from "../../i18n";
import { useApp, useAppStore } from "../../state";

/** Project references bind user-owned Personal Content Library items (`ref_*`)
 * so newly opened or refreshed Sessions mount them cleanly without copying blobs. */
export function ReferencesSettings({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const store = useAppStore();
  const userId = state.authSession?.authenticated
    ? state.authSession.principal?.owner
    : undefined;

  const [snapshot, setSnapshot] = useState<ReferencesSnapshot | null>(null);
  const [libraryItems, setLibraryItems] = useState<PersonalLibraryObject[]>([]);
  const [refIds, setRefIds] = useState<string[]>([]);

  // Quick-add shortcut straight into Personal Library + attach to project
  const [type, setType] =
    useState<PersonalLibraryShortcutTarget["type"]>("host_path");
  const [path, setPath] = useState("");
  const [root, setRoot] = useState(".");
  const [pattern, setPattern] = useState("");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [selectedLibraryId, setSelectedLibraryId] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const generation = useRef(0);
  const identity = JSON.stringify([userId, projectId]);
  const matches = state.sessions.some(
    (session) =>
      session.id === state.sessionId && session.projectID === projectId,
  );
  const dirty =
    JSON.stringify(refIds) !== JSON.stringify(snapshot?.ref_ids ?? []);

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
      const [next, lib] = await Promise.all([
        request("project.references.get") as Promise<ReferencesSnapshot>,
        userId
          ? store.api.libraryList(userId)
          : Promise.resolve({ items: [], quota: null as any }),
      ]);
      if (ticket === generation.current) {
        setSnapshot(next);
        setRefIds(next.ref_ids);
        setLibraryItems(lib.items);
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
    setRefIds([]);
    setLibraryItems([]);
    setPath("");
    setRoot(".");
    setPattern("");
    setUrl("");
    setTitle("");
    setStatus("");
    void load();
    return () => {
      generation.current++;
    };
  }, [identity]);

  const byId = useMemo(() => {
    const map = new Map<string, PersonalLibraryObject>();
    for (const item of libraryItems) map.set(item.id, item);
    for (const item of snapshot?.items ?? []) map.set(item.id, item);
    return map;
  }, [libraryItems, snapshot]);

  const save = async () => {
    if (!snapshot) return;
    const ticket = generation.current;
    try {
      setBusy(true);
      setError("");
      const next = (await request("project.references.set", {
        ref_ids: refIds,
      })) as ReferencesSnapshot;
      if (ticket === generation.current) {
        setSnapshot(next);
        setRefIds(next.ref_ids);
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
      await dispatch({
        type: "SettingsRequest",
        method: "session.references.refresh",
        sessionId: state.sessionId,
        params: {},
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

  const attachExisting = () => {
    if (!selectedLibraryId || refIds.includes(selectedLibraryId)) return;
    setRefIds([...refIds, selectedLibraryId]);
    setSelectedLibraryId("");
    setError("");
    setStatus("");
  };

  const createShortcutAndAttach = async () => {
    if (!userId) return;
    let target: PersonalLibraryShortcutTarget;
    if (type === "host_path") {
      if (!path.trim()) {
        setError("请填写工作区路径");
        return;
      }
      target = { type, path: path.trim(), project_id: projectId };
    } else if (type === "host_glob") {
      if (!pattern.trim()) {
        setError("请填写匹配模式");
        return;
      }
      target = {
        type,
        root: root.trim() || ".",
        pattern: pattern.trim(),
        project_id: projectId,
      };
    } else if (type === "directory_url") {
      if (!url.trim()) return;
      target = { type, url: url.trim() };
    } else {
      if (!url.trim()) return;
      target = { type: "public_https", url: url.trim() };
    }
    setBusy(true);
    setError("");
    try {
      const created = await store.api.libraryCreateJson(userId, {
        title: title.trim() || undefined,
        target,
      });
      setLibraryItems((prev) => [created, ...prev]);
      setRefIds((prev) =>
        prev.includes(created.id) ? prev : [...prev, created.id],
      );
      setPath("");
      setPattern("");
      setUrl("");
      setTitle("");
      setStatus("已添加至个人内容库并加入项目草稿，请点击保存更改。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const unattachedLibrary = libraryItems.filter(
    (item) => !refIds.includes(item.id),
  );

  return (
    <section
      className="settings-section-card"
      data-testid="project-references"
      aria-busy={busy}
    >
      <div className="settings-section-head">
        <h4 className="settings-section-title">
          {t("project.settings.refs.heading")}（关联个人内容库）
        </h4>
        <span className="limit-source-pill">{refIds.length}</span>
      </div>
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

      {/* Pick existing Personal Library item */}
      {unattachedLibrary.length > 0 && (
        <div className="project-ref-add" data-testid="project-ref-pick">
          <select
            className="settings-input"
            aria-label="选择个人内容库条目"
            value={selectedLibraryId}
            onChange={(e) => setSelectedLibraryId(e.target.value)}
          >
            <option value="">从个人内容库选择已有条目...</option>
            {unattachedLibrary.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ({sourceKindLabel(item.source_kind)} ·{" "}
                {item.id.slice(0, 12)})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost-btn"
            disabled={busy || !selectedLibraryId}
            onClick={attachExisting}
          >
            挂载到项目
          </button>
        </div>
      )}

      {/* Or create a new Shortcut directly in Personal Library */}
      <div className="project-ref-add" data-testid="project-ref-add">
        <select
          className="settings-input project-ref-type-select"
          aria-label={t("project.settings.refs.kind")}
          value={type}
          onChange={(event) =>
            setType(
              event.target.value as PersonalLibraryShortcutTarget["type"],
            )
          }
        >
          {["host_path", "host_glob", "directory_url", "public_https"].map(
            (kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ),
          )}
        </select>
        <input
          className="settings-input"
          placeholder="可选标题"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        {type === "host_path" && (
          <input
            className="settings-input monospace-text"
            aria-label={t("project.settings.refs.path")}
            placeholder={t("project.settings.refs.pathPlaceholder")}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        )}
        {type === "host_glob" && (
          <>
            <input
              className="settings-input monospace-text"
              aria-label={t("project.settings.refs.root")}
              placeholder={t("project.settings.refs.rootPlaceholder")}
              value={root}
              onChange={(event) => setRoot(event.target.value)}
            />
            <input
              className="settings-input monospace-text"
              aria-label={t("project.settings.refs.pattern")}
              placeholder={t("project.settings.refs.patternPlaceholder")}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
          </>
        )}
        {(type === "public_https" || type === "directory_url") && (
          <input
            className="settings-input monospace-text"
            aria-label={t("project.settings.refs.url")}
            placeholder={t(
              type === "directory_url"
                ? "project.settings.refs.dirUrlPlaceholder"
                : "project.settings.refs.urlPlaceholder",
            )}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        )}
        <button
          type="button"
          className="ghost-btn"
          disabled={busy || !snapshot || !userId}
          onClick={() => void createShortcutAndAttach()}
        >
          {t("project.settings.refs.add")}
        </button>
      </div>

      <div className="project-ref-list" data-testid="project-ref-list">
        {refIds.length ? (
          refIds.map((id) => {
            const entry = byId.get(id);
            return (
              <div
                className="project-ref-row"
                key={id}
                data-testid="project-ref-row"
              >
                <span className="limit-source-pill project-ref-kind">
                  {entry ? sourceKindLabel(entry.source_kind) : "ref"}
                </span>
                <span className="project-ref-main monospace-text">
                  {entry ? `${entry.title} (${id})` : id}
                  {entry?.byte_length !== undefined
                    ? ` · ${formatLibraryBytes(entry.byte_length)}`
                    : ""}
                </span>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy}
                  aria-label={t("project.settings.refs.remove")}
                  onClick={() => setRefIds(refIds.filter((item) => item !== id))}
                >
                  ×
                </button>
              </div>
            );
          })
        ) : (
          <p>{t("project.settings.refs.empty")}</p>
        )}
      </div>

      <div className="settings-actions-row">
        <button
          type="button"
          className="primary-btn"
          data-testid="project-ref-save"
          disabled={!snapshot || busy || !dirty}
          onClick={() => void save()}
        >
          {t("project.settings.refs.save")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={!snapshot || busy}
          onClick={() => {
            setRefIds(snapshot?.ref_ids ?? []);
            setStatus("");
          }}
        >
          {t("project.settings.refs.discard")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("ownerSettings.reload")}
        </button>
        <button
          type="button"
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
