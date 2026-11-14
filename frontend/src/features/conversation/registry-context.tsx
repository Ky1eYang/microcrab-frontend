import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createConversationRegistry,
  type ConversationRegistry,
} from "../../client/conversation/registry";
import { publishTranscript } from "../../client/conversation/assembler";
import type { Transcript } from "../../client/types";
import type { FeatureBlock } from "../shared";

const RegistryContext = createContext<{
  registry: ConversationRegistry;
  locale: string;
} | null>(null);

export function ConversationRegistryProvider({
  registry,
  locale,
  children,
}: {
  registry: ConversationRegistry;
  locale: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ registry, locale }), [registry, locale]);
  return (
    <RegistryContext.Provider value={value}>
      {children}
    </RegistryContext.Provider>
  );
}

/** Inspected children own their registry; publishing them never touches the main
 * session. Subsequent publications happen after commit, before browser paint. */
export function useIsolatedConversationRegistry(transcript?: Transcript) {
  const [registry] = useState(() => {
    const local = createConversationRegistry();
    if (transcript) publishTranscript(local, transcript);
    return local;
  });
  useLayoutEffect(() => {
    if (transcript) publishTranscript(registry, transcript);
  });
  const lifecycle = useRef(0);
  useEffect(() => {
    const generation = ++lifecycle.current;
    return () =>
      queueMicrotask(() => {
        // React may immediately replay setup after cleanup in development.
        if (lifecycle.current === generation) registry.dispose();
      });
  }, [registry]);
  return registry;
}

export function useConversationStructure(registry: ConversationRegistry) {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribeStructure(listener),
    [registry],
  );
  const snapshot = useCallback(() => registry.structureRevision, [registry]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const noSubscription = () => () => {};

/** Subscribe to versions rather than block identity: streamed payloads can be
 * mutable. A missing provider deliberately supports standalone render fixtures. */
export function useConversationBlock(fallback: FeatureBlock) {
  const context = useContext(RegistryContext);
  const registry = context?.registry;
  const subscribe = useCallback(
    (listener: () => void) =>
      registry?.subscribe(fallback.id, listener) ?? (() => {}),
    [registry, fallback.id],
  );
  const snapshot = useCallback(
    () => registry?.version(fallback.id) ?? 0,
    [registry, fallback.id],
  );
  const version = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    block: registry?.getBlock(fallback.id) ?? fallback,
    version: registry ? version : JSON.stringify(fallback),
    locale: context?.locale,
  };
}

/** Group chrome and copy actions observe exactly their members, independently
 * of the list's structural subscription. The version tuple is a stable snapshot. */
export function useConversationBlocks(fallback: FeatureBlock[]) {
  const context = useContext(RegistryContext);
  const registry = context?.registry;
  const ids = fallback.map((block) => block.id).join("\0");
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!registry) return noSubscription();
      const unsubscribes = fallback.map((block) =>
        registry.subscribe(block.id, listener),
      );
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    },
    [registry, ids],
  );
  const snapshot = useCallback(
    () => fallback.map((block) => registry?.version(block.id) ?? 0).join(","),
    [registry, ids],
  );
  const versions = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(
    () => fallback.map((block) => registry?.getBlock(block.id) ?? block),
    [registry, fallback, versions],
  );
}
