import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import type { AppState, AppAction } from "../client/types";
import { AppStore } from "./store";
interface AppContextValue {
  store: AppStore;
  dispatch: (action: AppAction) => Promise<any>;
}
// The provider identity is stable. Each consumer chooses its own subscription
// boundary; streaming a block must not invalidate every context consumer.
const AppContext = createContext<AppContextValue | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new AppStore());
  const context = useMemo(
    () => ({ store, dispatch: (action: AppAction) => store.dispatch(action) }),
    [store],
  );
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return <AppContext.Provider value={context}>{children}</AppContext.Provider>;
}
function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw Error("useApp must be used inside AppProvider");
  return context;
}
export function useAppStore() {
  return useAppContext().store;
}
export function useClientPlugins() {
  const store = useAppStore();
  useSyncExternalStore(
    store.plugins.subscribe,
    store.plugins.getSnapshot,
    store.plugins.getSnapshot,
  );
  return store.plugins;
}
export function useAppDispatch() {
  return useAppContext().dispatch;
}
/** Cache the selected value, not only the root state object. A caller can
 * subscribe to conversation structure without subscribing to every text delta. */
export function useAppSelector<T>(
  selector: (state: AppState) => T,
  equal: (previous: T, next: T) => boolean = Object.is,
): T {
  const { store } = useAppContext();
  const select = useRef(selector);
  const compare = useRef(equal);
  select.current = selector;
  compare.current = equal;
  const cached = useRef<{ value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const value = select.current(store.getSnapshot());
    if (!cached.current || !compare.current(cached.current.value, value))
      cached.current = { value };
    return cached.current.value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
export function useAppFields<K extends keyof AppState>(keys: readonly K[]) {
  const dispatch = useAppDispatch();
  const state = useAppSelector(
    (state) =>
      Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<
        AppState,
        K
      >,
    (previous, next) =>
      keys.every((key) => Object.is(previous[key], next[key])),
  );
  return { state, dispatch };
}
export function useApp() {
  const { store, dispatch } = useAppContext();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return { state, dispatch };
}
