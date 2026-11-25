import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { t } from "../../i18n";
import { CommandError } from "../../client/errors";
import type { BytesMetadata } from "../../client/state-inspection";
import type { AppState } from "../../client/types";
import { useAppSelector, useAppStore } from "../../state";
import { Icon } from "../shared";
import { sessionInspectionStatus } from "../shared/session-inspection-status";
import { JsonValueView } from "../content-inspection/JsonValueView";
import { formatJson } from "../content-inspection/format";
import { selectedStateSource } from "./exact-source";
import {
  buildNativeStateTree,
  buildStateTree,
  findStateNodes,
  type ExecutionCapacity,
  type StateNode,
  type StateTree,
} from "./inspection";
import { stateLabels, type StateLabels } from "./labels";
import { stateValuePreview } from "./value-preview";
import "./native-state-viewer.css";

export type ReadStateInspection = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<unknown>;

function scopeIdentity(state: AppState, sessionId: string | null) {
  const owner =
    state.authSession?.authenticated && state.authSession.principal?.owner;
  if (
    !owner ||
    state.authRequired ||
    state.page !== "conversation" ||
    state.viewMode !== "state" ||
    !sessionId ||
    state.sessionId !== sessionId ||
    state.sessionAttachingId ||
    state.sessionTransportRecovery ||
    state.popup?.type === "subagentDetail" ||
    state.historyMutationPending
  )
    return "";
  return JSON.stringify([
    owner,
    state.apiBase,
    sessionId,
    state.transcript.historyView?.lineage,
    state.transcript.historyView?.epoch,
    state.transcript.historyResetRevision,
  ]);
}

/** Only the active, authenticated root Session may mount an inspection. */
export function NativeStateViewer({
  sessionId,
  active = true,
  readInspection,
}: {
  sessionId: string | null;
  active?: boolean;
  readInspection?: ReadStateInspection;
}) {
  const store = useAppStore();
  const identity = useAppSelector((state) =>
    active ? scopeIdentity(state, sessionId) : "",
  );
  const locale = useAppSelector((state) => state.resolvedLocale);
  const labels = stateLabels[locale];
  const status = useAppSelector((state) => sessionInspectionStatus(state, sessionId));
  const stateSupported = useAppSelector(
    (state) =>
      state.capabilities?.methods.includes("state.inspection") === true,
  );
  const api = store.api;
  const current = useMemo(
    () => () =>
      store.api === api &&
      scopeIdentity(store.getSnapshot(), sessionId) === identity,
    [api, identity, sessionId, store],
  );
  const currentInspection = useMemo(
    () => () =>
      current() &&
      store.getSnapshot().capabilities?.methods.includes("state.inspection") ===
        true,
    [current, store],
  );
  const read = useMemo(
    () => async (id: string, signal: AbortSignal, isCurrent: () => boolean) => {
      if (!readInspection)
        return buildNativeStateTree(
          await api.readNativeStateInspection(id, signal, isCurrent),
        );
      const source = await readInspection(id, signal);
      signal.throwIfAborted();
      if (!isCurrent()) return;
      try {
        return buildStateTree(source);
      } catch {
        throw new CommandError(
          "invalid_result",
          "Injected State inspection is invalid",
        );
      }
    },
    [api, readInspection],
  );
  if (!active) return null;
  return (
    <section className="native-state-viewer" aria-label={labels.title}>
      {!identity || !sessionId ? (
        <p role="status">{status ? t(status, undefined, locale) : labels.unavailable}</p>
      ) : (
        <section key={identity} aria-label={labels.stateFields}>
          {stateSupported ? (
            <ScopedStateViewer
              labels={labels}
              sessionId={sessionId}
              read={read}
              current={currentInspection}
            />
          ) : (
            <>
              <p role="status">{labels.unavailable}</p>
              <Capacity labels={labels} />
            </>
          )}
        </section>
      )}
    </section>
  );
}

type Failure = "invalid" | "failure" | "tooLarge" | "forbidden";
type Snapshot = { tree: StateTree } | { error: Failure };

type ReadStateTree = (
  id: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
) => Promise<StateTree | undefined>;

function ScopedStateViewer({
  labels,
  sessionId,
  read,
  current,
}: {
  labels: StateLabels;
  sessionId: string;
  read: ReadStateTree;
  current: () => boolean;
}) {
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const copyScope = useMemo(
    () => ({ active: false }),
    [attempt, read, current],
  );
  useLayoutEffect(() => {
    copyScope.active = true;
    return () => {
      copyScope.active = false;
    };
  }, [copyScope]);
  const [result, setResult] = useState<{
    attempt: number;
    read: ReadStateTree;
    current: () => boolean;
    snapshot: Snapshot;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const isCurrent = () => copyScope.active && current();
    const admit = (snapshot: Snapshot) => {
      if (!signal.aborted && isCurrent())
        setResult({ attempt, read, current, snapshot });
    };
    async function load() {
      if (!isCurrent()) return;
      try {
        const tree = await read(sessionId, signal, isCurrent);
        if (tree) admit({ tree });
      } catch (error) {
        admit({
          error:
            error instanceof CommandError && error.code === "limit_exceeded"
              ? "tooLarge"
              : error instanceof CommandError && error.code === "invalid_result"
                ? "invalid"
                : error instanceof CommandError && ["forbidden", "permission_denied"].includes(error.code)
                  ? "forbidden"
                  : "failure",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, current, read, sessionId]);
  const snapshot =
    current() &&
    result?.attempt === attempt &&
    result.read === read &&
    result.current === current
      ? result.snapshot
      : undefined;
  return (
    <>
      <div className="native-state-toolbar">
        <input
          type="search"
          className="settings-input"
          value={query}
          maxLength={160}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={labels.search}
          placeholder={labels.search}
        />
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            copyScope.active = false;
            setAttempt((n) => n + 1);
          }}
        >
          {labels.refresh}
        </button>
      </div>
      {snapshot && (
        <Capacity
          labels={labels}
          capacity={
            "tree" in snapshot ? snapshot.tree.executionCapacity : undefined
          }
        />
      )}
      {!snapshot ? (
        <p role="status">{labels.loading}</p>
      ) : "error" in snapshot ? (
        <p className="inline-notice" role="alert">
          {labels[snapshot.error]}
        </p>
      ) : (
        <StateContents
          labels={labels}
          tree={snapshot.tree}
          query={query}
          current={() => copyScope.active && current()}
        />
      )}
    </>
  );
}

function Capacity({
  labels,
  capacity,
}: {
  labels: StateLabels;
  capacity?: ExecutionCapacity;
}) {
  return (
    <div className="native-state-capacity">
      <h3>{labels.capacity}</h3>
      <dl>
        {(["buffers", "pending"] as const).map((key) => {
          const count = capacity?.[key];
          return (
            <div key={key}>
              <dt>{labels[key]}</dt>
              <dd>
                {count
                  ? labels.capacityCount
                      .replace("{used}", String(count.used))
                      .replace("{limit}", String(count.limit))
                      .replace("{remaining}", String(count.remaining))
                  : labels.unknown}
              </dd>
            </div>
          );
        })}
      </dl>
      {(capacity?.buffers || capacity?.pending) && <p>{labels.capacityHint}</p>}
    </div>
  );
}

function StateContents({
  labels,
  tree,
  query,
  current,
}: {
  labels: StateLabels;
  tree: StateTree;
  query: string;
  current: () => boolean;
}) {
  const [selection, setSelection] = useState<{ key: number | string }>();
  const selectionRef = useRef(selection);
  function select(key: number | string) {
    if (!current() || selectionRef.current?.key === key) return;
    const next = { key };
    selectionRef.current = next;
    setSelection(next);
  }
  const detailsId = useId();
  const details = useRef<HTMLDivElement>(null);
  const currentSelection = () =>
    current() && selectionRef.current === selection;
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const matches = useMemo(
    () => findStateNodes(tree.roots, query),
    [query, tree],
  );
  const term = query.trim().toLowerCase();
  const search = Boolean(term);
  const matchingBytes = tree.bytes.filter(({ name }) =>
    name.toLowerCase().includes(term),
  );
  const selectedKey = selection?.key;
  const selectedBytes = matchingBytes.find(({ name }) => name === selectedKey);
  const selected =
    typeof selectedKey === "number" && (!search || matches.has(selectedKey))
      ? tree.nodes.get(selectedKey)
      : undefined;
  useLayoutEffect(() => {
    const detail = details.current;
    if (detail && getComputedStyle(detail).overflowY === "auto")
      detail.scrollTop = 0;
  }, [selection]);
  function toggle(id: number) {
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function render(nodes: StateNode[], id?: string): ReactNode {
    return (
      <ul id={id} className="native-state-tree">
        {nodes.map((node) => {
          if (search && !matches.has(node.id)) return null;
          const hasChildren = node.children.length > 0;
          const open = hasChildren && (search || expanded.has(node.id));
          return (
            <StateBranch
              key={node.id}
              node={node}
              labels={labels}
              open={open}
              search={search}
              selected={selected?.id === node.id}
              detailsId={detailsId}
              select={() => select(node.id)}
              toggle={() => toggle(node.id)}
              render={render}
            />
          );
        })}
      </ul>
    );
  }
  if (!tree.roots.length && !tree.bytes.length)
    return <p role="status">{labels.empty}</p>;
  return (
    <>
      {tree.limited && (
        <p className="inline-notice" role="status">
          {labels.limited}
        </p>
      )}
      {search && !matches.size && !matchingBytes.length ? (
        <p role="status">{labels.noMatches}</p>
      ) : (
        <div className="native-state-layout">
          <nav aria-label={labels.title}>
            {render(tree.roots)}
            {!!matchingBytes.length && (
              <section
                className="native-state-bytes"
                aria-label={labels.privateBytes}
              >
                <h3>{labels.privateBytes}</h3>
                <ul className="native-state-tree">
                  {matchingBytes.map(({ name }) => (
                    <li key={name} className="native-state-row">
                      <span
                        aria-hidden="true"
                        className="native-state-spacer"
                      />
                      <button
                        className="native-state-key"
                        type="button"
                        aria-pressed={selectedBytes?.name === name}
                        aria-controls={detailsId}
                        onClick={() => select(name)}
                      >
                        <code>{name}</code>
                        <small>{labels.bytes}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </nav>
          <div className="native-state-detail" id={detailsId} ref={details}>
            {selectedBytes ? (
              <BytesDetails
                key={selectedBytes.selector}
                labels={labels}
                bytes={selectedBytes}
                current={currentSelection}
              />
            ) : selected ? (
              <StateDetails
                key={selected.id}
                labels={labels}
                node={selected}
                tree={tree}
                current={currentSelection}
              />
            ) : (
              <p>{labels.select}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function StateBranch({
  node,
  labels,
  open,
  search,
  selected,
  detailsId,
  select,
  toggle,
  render,
}: {
  node: StateNode;
  labels: StateLabels;
  open: boolean;
  search: boolean;
  selected: boolean;
  detailsId: string;
  select: () => void;
  toggle: () => void;
  render: (nodes: StateNode[], id?: string) => ReactNode;
}) {
  const childrenId = useId();
  return (
    <li>
      <div className="native-state-row">
        {node.children.length > 0 && (!search || open) ? (
          <button
            type="button"
            className="native-state-disclosure"
            aria-expanded={open}
            aria-controls={open ? childrenId : undefined}
            aria-label={`${open ? labels.collapse : labels.expand}: ${node.label}`}
            disabled={search}
            onClick={toggle}
          >
            <Icon name="chevron" size={13} aria-hidden="true" />
          </button>
        ) : (
          <span aria-hidden="true" className="native-state-spacer" />
        )}
        <button
          className="native-state-key"
          type="button"
          aria-pressed={selected}
          aria-controls={detailsId}
          onClick={select}
        >
          <code>{node.label}</code>
          {node.metadata.visibility === "secret" ? (
            <small className="native-state-secret" data-visibility="secret">
              <Icon name="key" size={12} aria-hidden="true" />
              {labels.secret}
            </small>
          ) : (
            node.type && <small>{labels[node.type]}</small>
          )}
        </button>
      </div>
      {open && render(node.children, childrenId)}
    </li>
  );
}

function BytesDetails({
  labels,
  bytes,
  current,
}: {
  labels: StateLabels;
  bytes: BytesMetadata;
  current: () => boolean;
}) {
  const [copy, setCopy] = useState<
    "imageSourceCopied" | "imageSourceCopyFailed"
  >();
  const facts = [
    [labels.type, labels[bytes.kind]],
    [labels.mediaType, bytes.media_type],
    [labels.byteLength, String(bytes.byte_length)],
    [labels.lifecycle, labels[bytes.lifecycle]],
    [labels.availability, labels[bytes.availability]],
    [labels.revision, bytes.revision],
  ];
  if (bytes.redirect_execution_id)
    facts.push([labels.redirectExecution, bytes.redirect_execution_id]);
  async function copyImageSource() {
    if (!current()) return;
    try {
      await navigator.clipboard.writeText(`{{var:base64:@${bytes.selector}}}`);
      if (current()) setCopy("imageSourceCopied");
    } catch {
      if (current()) setCopy("imageSourceCopyFailed");
    }
  }
  return (
    <>
      <h3>
        {labels.details}: <code>{bytes.name}</code>
      </h3>
      <dl>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>{labels.bytesNotPreviewed}</p>
      <p>{labels.bytesHint}</p>
      <button
        type="button"
        className="ghost-btn"
        onClick={() => void copyImageSource()}
      >
        <Icon name="copy" aria-hidden="true" />
        {labels.copyImageSource}
      </button>
      {copy && <p role="status">{labels[copy]}</p>}
    </>
  );
}

function StateDetails({
  labels,
  node,
  tree,
  current,
}: {
  labels: StateLabels;
  node: StateNode;
  tree: StateTree;
  current: () => boolean;
}) {
  const [copy, setCopy] = useState<"copied" | "copyFailed">();
  const locale = useAppSelector((state) => state.resolvedLocale);
  const { descriptor, metadata, reference } = node;
  const [exact, setExact] = useState(false);
  const previewTitle = useId();
  const root =
    node.rootKey === undefined ? undefined : tree.exactRoots?.get(node.rootKey);
  const path = node.path;
  const [resolved, setResolved] = useState<string>();
  useEffect(() => {
    if (root === undefined || !path?.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    void selectedStateSource(root, path, signal).then(
      (value) => {
        if (!signal.aborted && current()) setResolved(value);
      },
      () => {
        /* Preserve bounded Text when no exact range can be resolved. */
      },
    );
    return () => controller.abort();
    // StateDetails is keyed by the selected node in one immutable snapshot.
  }, [root, path]);
  const source = path?.length ? resolved : root;
  const compact =
    node.rootKey === undefined
      ? undefined
      : tree.compactStrings.get(node.rootKey);
  const displayString = useMemo(() => {
    if (!compact || !path) return undefined;
    return (relative: readonly (string | number)[], text: string) => {
      const projection = compact.get(
        JSON.stringify([...path, ...relative.map(String)]),
      );
      return projection?.exact === text ? projection.label : text;
    };
  }, [compact, path]);
  const preview = useMemo(() => stateValuePreview(node), [node]);
  const text = useMemo(() => {
    if (preview.kind === "none") return;
    if (
      source !== undefined &&
      source.length <= 4096 &&
      preview.kind !== "excerpt"
    ) {
      try {
        const formatted = formatJson(
          source,
          displayString &&
            ((relative, lexeme) => {
              const exactText = JSON.parse(lexeme) as string;
              const label = displayString(relative, exactText);
              return label === exactText ? lexeme : JSON.stringify(label);
            }),
        );
        if (new TextEncoder().encode(formatted).length <= 4096)
          return formatted;
      } catch {
        // A bounded display failure never changes the original copy source.
      }
    }
    return preview.text;
  }, [preview, source, displayString]);
  const yesNo = (flag?: boolean) =>
    flag === undefined ? labels.unknown : labels[flag ? "yes" : "no"];
  const facts = [
    [labels.type, node.type && labels[node.type]],
    [labels.visibility, metadata.visibility && labels[metadata.visibility]],
    [labels.persistence, metadata.persistence && labels[metadata.persistence]],
    [labels.owner, metadata.owner && labels[metadata.owner]],
    [labels.editors, metadata.editors?.map((role) => labels[role]).join(", ")],
    [labels.descriptor, descriptor.kind && labels[descriptor.kind]],
    [labels.editable, yesNo(descriptor.editable)],
    [labels.ownerEditable, yesNo(descriptor.owner_editable)],
    [labels.deletable, yesNo(descriptor.deletable)],
    [labels.revision, tree.revision],
  ];
  async function copyReference() {
    if (!reference || !current()) return;
    try {
      await navigator.clipboard.writeText(reference);
      if (current()) setCopy("copied");
    } catch {
      if (current()) setCopy("copyFailed");
    }
  }
  const renderText = () =>
    preview.kind === "scalar" ? (
      <pre>
        {exact && node.exact && current() ? JSON.stringify(node.exact) : text}
      </pre>
    ) : preview.kind === "none" ? null : (
      <>
        {preview.kind === "excerpt" && <p>{labels.previewTruncated}</p>}
        <pre className="native-state-container-preview">{text}</pre>
      </>
    );
  const exactToggleLabel = t(exact ? "references.compact" : "references.exact");
  return (
    <>
      <h3>
        {labels.details}: <code>{node.label}</code>
      </h3>
      <dl>
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || labels.unknown}</dd>
          </div>
        ))}
      </dl>
      {metadata.visibility === "secret" ? (
        <p className="inline-notice native-state-protected" data-tone="neutral">
          <Icon name="key" size={14} aria-hidden="true" />
          <span>{labels.protected}</span>
        </p>
      ) : preview.kind !== "none" ? (
        <section aria-labelledby={previewTitle}>
          <div className="native-state-preview-head">
            <h4 id={previewTitle}>{labels.value}</h4>
            {preview.kind === "scalar" && node.exact && (
              <button
                type="button"
                className="native-state-exact-btn"
                aria-pressed={exact}
                aria-label={exactToggleLabel}
                title={exactToggleLabel}
                onClick={() => {
                  if (current()) setExact(!exact);
                }}
              >
                <Icon name="file-code" size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          {preview.kind !== "scalar" && (
            <p className="native-state-preview-type">{labels[preview.type]}</p>
          )}
          {source === undefined ? (
            renderText()
          ) : (
            <JsonValueView
              source={{ kind: "text", text: source }}
              scopeKey={JSON.stringify([
                tree.runtime,
                tree.revision,
                node.rootKey,
                path,
              ])}
              displayString={displayString}
              locale={locale}
              isCurrent={current}
              renderText={renderText}
              className="native-state-json"
            />
          )}
        </section>
      ) : null}
      {reference && (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void copyReference()}
        >
          <Icon name="copy" aria-hidden="true" />
          {labels.copy}
        </button>
      )}
      {copy && <p role="status">{labels[copy]}</p>}
    </>
  );
}
