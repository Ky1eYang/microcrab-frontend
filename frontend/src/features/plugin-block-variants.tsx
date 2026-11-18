import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAppSelector, useAppStore, useClientPlugins } from "../state";
import { useConversationBlocks } from "./conversation/registry-context";
import {
  sessionTabPlugins,
  selectedSessionPlugin,
} from "../plugins/session-tabs";
import type {
  BlockTextVariant,
  PluginSurfaceDescriptor,
} from "../plugins/types";
import type { FeatureBlock } from "./shared";
import type { ActionMenuItem, ActionMenuGroup } from "./action-menu";
import { interleavedMarkdownText } from "./markdown-interleaved";
import { t } from "../i18n";

type Display = "original" | "variant" | "both";
type Variant = BlockTextVariant & { pluginId: string };
const groupKey = (variant: Variant) =>
  JSON.stringify([variant.pluginId, variant.variant_id]);
const variantKey = (variant: Variant) =>
  JSON.stringify([variant.pluginId, variant.block_id, variant.variant_id]);
const eligible = (block: FeatureBlock) =>
  block.role === "assistant" &&
  block.kind === "text" &&
  block.stream === "complete" &&
  !block.temporary &&
  !block.payload.failure;
const actionFor = (variant: Variant) =>
  variant.status === "skipped"
    ? variant.force_action
    : ["completed", "error", "cancelled"].includes(variant.status)
      ? variant.retry_action
      : undefined;
const BlockVariants = createContext<{
  variants: Map<string, Variant>;
  mode: Display;
  errors: Record<string, string>;
} | null>(null);
const AnswerVariants = createContext<{
  variants: Map<string, Variant>;
  mode: Display;
  actions: readonly ActionMenuGroup[];
  actionScope: string;
  errors: Record<string, string>;
} | null>(null);

/** Presentation state belongs to this mounted answer, never to transcript/history. */
export function PluginAnswerVariants({
  blocks: fallback,
  readOnly,
  children,
}: {
  blocks: FeatureBlock[];
  readOnly: boolean;
  children: ReactNode;
}) {
  const plugins = useClientPlugins();
  const store = useAppStore();
  const blocks = useConversationBlocks(fallback);
  const registry = readOnly ? null : plugins.registry;
  const scope = useAppSelector((state) =>
    JSON.stringify([
      state.authSession?.principal?.owner ?? "",
      state.apiBase,
      state.sessionId,
      state.transcript.historyView?.lineage ?? "",
      state.transcript.historyView?.epoch ?? null,
    ]),
  );
  const visibility = useAppSelector((state) =>
    JSON.stringify({
      sessionId: state.sessionId,
      page: state.page,
      viewMode: state.viewMode,
      locale: state.resolvedLocale,
      pluginWorkspace: state.pluginWorkspace,
      tab: state.sessionPluginTab,
      popup: state.popup,
    }),
  );
  const selection = JSON.parse(visibility);
  const entries = registry?.getSnapshot() ?? [];
  const tabs = sessionTabPlugins(
    entries,
    (id) => registry?.isEnabled(id, selection.sessionId) ?? false,
  );
  const visible =
    !readOnly &&
    !selection.pluginWorkspace &&
    selection.page === "conversation" &&
    selection.viewMode === "chat" &&
    !selectedSessionPlugin(selection.tab, selection.sessionId, tabs) &&
    !(
      selection.popup.type === "subagentDetail" &&
      selection.popup.parentId === selection.sessionId
    );
  const history = `${scope}:${plugins.historyRevision}`;
  const source = JSON.stringify([
    history,
    blocks.filter(eligible).map((block) => [block.id, block.payload.text]),
  ]);
  const [override, setOverride] = useState<{
    source: string;
    registry: typeof registry;
    mode?: Display;
    group?: string;
  } | null>(null);
  const current =
    override?.source === source && override.registry === registry
      ? override
      : null;
  const available = blocks
    .filter(
      (block) => eligible(block) && block.sessionId === selection.sessionId,
    )
    .flatMap(
      (block) => registry?.getBlockVariants(block.id, block.payload.text) ?? [],
    )
    .filter(
      (variant) =>
        entries.some(
          (entry) =>
            entry.manifest.id === variant.pluginId && entry.status === "ready",
        ) && registry?.isEnabled(variant.pluginId, selection.sessionId),
    );
  const groups = new Map<string, Variant>();
  for (const variant of available) groups.set(groupKey(variant), variant);
  const chosenGroup = current?.group
    ? groups.has(current.group)
      ? current.group
      : undefined
    : groups.size === 1
      ? groups.keys().next().value
      : undefined;
  const variants = new Map(
    available
      .filter((variant) => groupKey(variant) === chosenGroup)
      .map((variant) => [variant.block_id, variant]),
  );
  const completed = [...variants.values()].find(
    (variant) => variant.status === "completed",
  );
  const mode =
    current?.mode ??
    (completed
      ? completed.default_display === "inline"
        ? "variant"
        : "both"
      : "original");
  const update = (group: string, mode: Display) =>
    setOverride({ source, registry, group, mode });

  const surfaceIds = useRef(new Map<string, string>());
  const liveSurfaceIds = new Set<string>();
  const surfaceId = (variant: Variant) => {
    const identity = JSON.stringify([
      history,
      variantKey(variant),
      variant.source_digest,
      variant.history_revision,
    ]);
    liveSurfaceIds.add(identity);
    let id = surfaceIds.current.get(identity);
    if (!id) {
      id = crypto.randomUUID();
      surfaceIds.current.set(identity, id);
    }
    return id;
  };
  // Identity excludes changing status/text/action metadata. Progress must not hide a live
  // surface: doing so retires its in-flight resources in the Host.
  const identities = JSON.stringify(
    available
      .map((variant) => ({
        key: variantKey(variant),
        pluginId: variant.pluginId,
        source: blocks.find((block) => block.id === variant.block_id)!.payload
          .text,
        digest: variant.source_digest,
        revision: variant.history_revision,
        descriptor: {
          surface_id: surfaceId(variant),
          target: "block-slot",
          block_id: variant.block_id,
          slot_id: variant.variant_id,
          placement: "after",
        },
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
  for (const identity of surfaceIds.current.keys())
    if (!liveSurfaceIds.has(identity)) surfaceIds.current.delete(identity);
  const surfaces = useMemo(
    () =>
      JSON.parse(identities) as {
        key: string;
        pluginId: string;
        source: string;
        digest: string;
        revision: string;
        descriptor: PluginSurfaceDescriptor;
      }[],
    [identities],
  );
  const mounts = useRef(
    new Map<
      string,
      {
        descriptor: PluginSurfaceDescriptor;
        generation: unknown;
        pluginId: string;
        identity: string;
      }
    >(),
  );
  const latest = useRef({ visible, registry, source });
  latest.current = { visible, registry, source };
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorScope = useRef(source);
  useEffect(() => {
    const active = new Map<
      string,
      {
        descriptor: PluginSurfaceDescriptor;
        generation: unknown;
        pluginId: string;
        identity: string;
      }
    >();
    mounts.current = active;
    pending.current = new Set();
    setBusy(new Set());
    setErrors({});
    return () => {
      if (mounts.current === active) mounts.current = new Map();
      for (const mount of active.values())
        registry?.setSurfaceVisible(mount.pluginId, mount.descriptor, false);
    };
  }, [registry, visible, history]);
  useEffect(() => {
    if (!registry || !visible) return;
    const active = mounts.current;
    let changed = false;
    for (const [key, mount] of active) {
      const surface = surfaces.find((surface) => surface.key === key);
      if (!surface || JSON.stringify(surface) !== mount.identity) {
        registry.setSurfaceVisible(mount.pluginId, mount.descriptor, false);
        active.delete(key);
        pending.current.delete(key);
        changed = true;
      }
    }
    for (const surface of surfaces) {
      if (active.has(surface.key)) continue;
      try {
        registry.setSurfaceVisible(surface.pluginId, surface.descriptor, true);
        active.set(surface.key, {
          descriptor: surface.descriptor,
          pluginId: surface.pluginId,
          identity: JSON.stringify(surface),
          generation: registry.view(
            surface.pluginId,
            "block-slot",
            surface.descriptor,
          ).instanceGeneration,
        });
        changed = true;
      } catch (reason) {
        setErrors((errors) => ({ ...errors, [surface.key]: String(reason) }));
      }
    }
    if (changed) setBusy(new Set(pending.current));
  }, [registry, surfaces, visible, history]);
  useEffect(() => {
    errorScope.current = source;
    setErrors({});
  }, [source]);

  const invoke = async (variant: Variant, requested: string) => {
    const snapshot = store.getSnapshot();
    const scopeNow = JSON.stringify([
      snapshot.authSession?.principal?.owner ?? "",
      snapshot.apiBase,
      snapshot.sessionId,
      snapshot.transcript.historyView?.lineage ?? "",
      snapshot.transcript.historyView?.epoch ?? null,
    ]);
    const tabsNow = registry
      ? sessionTabPlugins(registry.getSnapshot(), (id) =>
          registry.isEnabled(id, snapshot.sessionId),
        )
      : [];
    if (
      readOnly ||
      plugins.registry !== registry ||
      scopeNow !== scope ||
      `${scopeNow}:${plugins.historyRevision}` !== history ||
      snapshot.page !== "conversation" ||
      snapshot.viewMode !== "chat" ||
      snapshot.pluginWorkspace ||
      selectedSessionPlugin(
        snapshot.sessionPluginTab,
        snapshot.sessionId,
        tabsNow,
      ) ||
      (snapshot.popup.type === "subagentDetail" &&
        snapshot.popup.parentId === snapshot.sessionId)
    )
      return;
    const key = variantKey(variant),
      mount = mounts.current.get(key);
    const surface = surfaces.find((surface) => surface.key === key);
    if (
      !registry ||
      !visible ||
      !latest.current.visible ||
      latest.current.registry !== registry ||
      latest.current.source !== source ||
      !mount ||
      !surface ||
      pending.current.has(key)
    )
      return;
    const block = blocks.find((block) => block.id === variant.block_id);
    const actual =
      block &&
      eligible(block) &&
      block.sessionId === selection.sessionId &&
      registry
        .getBlockVariants(block.id, block.payload.text)
        .find((item) => variantKey(item) === key);
    if (
      !actual ||
      block!.payload.text !== surface.source ||
      actual.source_digest !== surface.digest ||
      actual.history_revision !== surface.revision ||
      actionFor(actual) !== requested ||
      !registry.isEnabled(variant.pluginId, selection.sessionId) ||
      !registry
        .getSnapshot()
        .some(
          (entry) =>
            entry.manifest.id === variant.pluginId && entry.status === "ready",
        ) ||
      registry.view(variant.pluginId, "block-slot", mount.descriptor)
        .instanceGeneration !== mount.generation
    )
      return;
    const active = mounts.current;
    pending.current.add(key);
    setBusy(new Set(pending.current));
    setErrors((errors) => {
      const next = { ...errors };
      delete next[key];
      return next;
    });
    try {
      await registry.action(
        variant.pluginId,
        requested,
        { block_id: variant.block_id },
        mount.descriptor,
      );
    } catch (reason) {
      if (
        latest.current.registry === registry &&
        latest.current.source === source &&
        latest.current.visible
      )
        setErrors((errors) => ({ ...errors, [key]: String(reason) }));
    } finally {
      if (mounts.current === active && mounts.current.get(key) === mount) {
        pending.current.delete(key);
        setBusy(new Set(pending.current));
      }
    }
  };
  const groupItems = (key: string, variant: Variant): ActionMenuItem[] => {
    const choices: ActionMenuItem[] = (
      ["original", "variant", "both"] as const
    ).map((value) => ({
      id: `${key}:${value}`,
      label:
        value === "original"
          ? t("variants.original")
          : value === "variant"
            ? variant.label
            : t("variants.originalAndVariant", { label: variant.label }),
      checked: chosenGroup === key && mode === value,
      disabled: !visible,
      onSelect: () => update(key, value),
    }));
    for (const item of available.filter((item) => groupKey(item) === key)) {
      const action = actionFor(item);
      if (!action) continue;
      const matching = available.filter(
        (candidate) => groupKey(candidate) === key && actionFor(candidate),
      );
      choices.push({
        id: `${variantKey(item)}:action`,
        label: `${t(item.status === "skipped" ? "variants.forceVariant" : item.status === "completed" ? "variants.regenerateVariant" : "variants.retryVariant", { label: item.label })}${matching.length > 1 ? ` · ${blocks.findIndex((block) => block.id === item.block_id) + 1}` : ""}`,
        disabled: !visible || busy.has(variantKey(item)),
        onSelect: () => void invoke(item, action),
      });
    }
    return choices;
  };
  const providers = new Map<string, [string, Variant][]>();
  for (const entry of groups)
    providers.set(entry[1].pluginId, [
      ...(providers.get(entry[1].pluginId) ?? []),
      entry,
    ]);
  const actions: ActionMenuGroup[] = [...providers].map(
    ([pluginId, providerGroups]) => ({
      id: pluginId,
      label: entries.find((entry) => entry.manifest.id === pluginId)!.manifest
        .name,
      items:
        providerGroups.length === 1
          ? groupItems(...providerGroups[0])
          : providerGroups.map(([key, variant]) => ({
              id: key,
              label: variant.label,
              items: groupItems(key, variant),
            })),
    }),
  );
  const presentationKey = JSON.stringify([
    [...variants],
    mode,
    errorScope.current === source ? errors : {},
  ]);
  const presentation = useMemo(
    () => ({
      variants,
      mode,
      errors: errorScope.current === source ? errors : {},
    }),
    [presentationKey],
  );
  return (
    <BlockVariants.Provider value={presentation}>
      <AnswerVariants.Provider
        value={{
          variants,
          mode,
          actions,
          actionScope: JSON.stringify([source, visible]),
          errors: errorScope.current === source ? errors : {},
        }}
      >
        {children}
      </AnswerVariants.Provider>
    </BlockVariants.Provider>
  );
}

export function useBlockTextVariant(block: FeatureBlock) {
  const answer = useContext(BlockVariants);
  return {
    variant: eligible(block) ? answer?.variants.get(block.id) : undefined,
    mode: answer?.mode ?? "original",
  };
}

export function useAnswerVariantActions(blocks: FeatureBlock[]) {
  const answer = useContext(AnswerVariants);
  const mode = answer?.mode ?? "original";
  const copyInputs = JSON.stringify(
    blocks.map((block) => {
      const variant = eligible(block)
        ? answer?.variants.get(block.id)
        : undefined;
      return [
        block.payload.text,
        variant?.status === "completed" && mode !== "original"
          ? variant.text
          : null,
      ];
    }),
  );
  const text = useMemo(
    () =>
      (JSON.parse(copyInputs) as [string, string | null][])
        .map(([original, variant]) =>
          variant === null
            ? original
            : mode === "both"
              ? interleavedMarkdownText(original, variant)
              : variant,
        )
        .join("\n\n"),
    [copyInputs, mode],
  );
  return {
    text,
    pluginActions: answer?.actions,
    actionScope: answer?.actionScope,
  };
}

/** Read-only status; all plugin controls belong to the answer's native More menu. */
export function PluginBlockVariant({ block }: { block: FeatureBlock }) {
  const answer = useContext(BlockVariants);
  const { variant } = useBlockTextVariant(block);
  const errors = Object.entries(answer?.errors ?? {}).filter(
    ([key]) => JSON.parse(key)[1] === block.id,
  );
  if ((!variant || variant.status === "completed") && !errors.length)
    return null;
  return (
    <div
      className="block-variant-status"
      role="status"
      data-testid="block-variant-status"
      data-status={variant?.status}
    >
      {variant && (
        <span>
          {variant.label}
          {variant.status !== "completed"
            ? ` · ${t(`variants.status.${variant.status}`)}`
            : ""}
          {variant.reason ? ` · ${t(`variants.reason.${variant.reason}`)}` : ""}
          {variant.error ? ` · ${variant.error}` : ""}
        </span>
      )}
      {errors.map(([key, error]) => (
        <span role="alert" key={key}>
          {error}
        </span>
      ))}
    </div>
  );
}
