import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CommandError } from "../../client/errors";
import type { AppState } from "../../client/types";
import { useAppSelector, useAppStore } from "../../state";
import { Icon } from "../shared";
import {
  buildStateTree,
  findStateNodes,
  type ExecutionCapacity,
  type StateInspection,
  type StateNode,
  type StateTree,
} from "./inspection";
import { stateLabels, type StateLabels } from "./labels";
import "./native-state-viewer.css";

export type ReadStateInspection = (
  sessionId: string,
  signal: AbortSignal,
) => Promise<StateInspection>;

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
  const stateSupported = useAppSelector(
    (state) =>
      state.capabilities?.methods.includes("state.inspection") === true,
  );
  const api = store.api;
  const read = useMemo<ReadStateInspection>(
    () =>
      readInspection ??
      ((id, signal) =>
        api.request<StateInspection>(
          "state.inspection",
          {},
          id,
          undefined,
          undefined,
          signal,
        )),
    [api, readInspection],
  );
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
  if (!active) return null;
  return (
    <section className="native-state-viewer" aria-label={labels.title}>
      {!identity || !sessionId ? (
        <p role="status">{labels.unavailable}</p>
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

type Failure = "invalid" | "failure" | "tooLarge";
type Snapshot = { tree: StateTree } | { error: Failure };

function ScopedStateViewer({
  labels,
  sessionId,
  read,
  current,
}: {
  labels: StateLabels;
  sessionId: string;
  read: ReadStateInspection;
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
    read: ReadStateInspection;
    snapshot: Snapshot;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const admit = (snapshot: Snapshot) => {
      if (!signal.aborted && current()) setResult({ attempt, read, snapshot });
    };
    async function load() {
      if (!current()) return;
      try {
        const source = await read(sessionId, signal);
        if (signal.aborted || !current()) return;
        try {
          admit({ tree: buildStateTree(source) });
        } catch {
          admit({ error: "invalid" });
        }
      } catch (error) {
        admit({
          error:
            error instanceof CommandError && error.code === "limit_exceeded"
              ? "tooLarge"
              : error instanceof CommandError && error.code === "invalid_result"
                ? "invalid"
                : "failure",
        });
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt, current, read, sessionId]);
  const snapshot =
    current() && result?.attempt === attempt && result.read === read
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
          onClick={() => setAttempt((n) => n + 1)}
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
  const [selectedId, setSelected] = useState<number>();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const matches = useMemo(
    () => findStateNodes(tree.roots, query),
    [query, tree],
  );
  const search = Boolean(query.trim());
  const selected =
    selectedId !== undefined && (!search || matches.has(selectedId))
      ? tree.nodes.get(selectedId)
      : undefined;
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
              select={() => setSelected(node.id)}
              toggle={() => toggle(node.id)}
              render={render}
            />
          );
        })}
      </ul>
    );
  }
  if (!tree.roots.length) return <p role="status">{labels.empty}</p>;
  return (
    <>
      {tree.limited && (
        <p className="inline-notice" role="status">
          {labels.limited}
        </p>
      )}
      {search && !matches.size ? (
        <p role="status">{labels.noMatches}</p>
      ) : (
        <div className="native-state-layout">
          <nav aria-label={labels.title}>{render(tree.roots)}</nav>
          <div className="native-state-detail">
            {selected ? (
              <StateDetails
                key={selected.id}
                labels={labels}
                node={selected}
                revision={tree.revision}
                current={current}
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
  select,
  toggle,
  render,
}: {
  node: StateNode;
  labels: StateLabels;
  open: boolean;
  search: boolean;
  selected: boolean;
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
          onClick={select}
        >
          <code>{node.label}</code>
          {node.metadata.visibility === "secret" ? (
            <small>{labels.secret}</small>
          ) : (
            node.type && <small>{labels[node.type]}</small>
          )}
        </button>
      </div>
      {open && render(node.children, childrenId)}
    </li>
  );
}

function StateDetails({
  labels,
  node,
  revision,
  current,
}: {
  labels: StateLabels;
  node: StateNode;
  revision: string;
  current: () => boolean;
}) {
  const [copy, setCopy] = useState<"copied" | "copyFailed">();
  const { descriptor, metadata, reference } = node;
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
    [labels.revision, revision],
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
        <p>{labels.protected}</p>
      ) : (
        node.preview !== undefined && (
          <>
            <h4>{labels.value}</h4>
            <pre>{node.preview}</pre>
          </>
        )
      )}
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
