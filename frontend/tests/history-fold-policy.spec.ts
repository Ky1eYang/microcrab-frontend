import { expect, test } from "@playwright/test";
import {
  historyFoldPolicy,
  type HistoryFoldInput,
  type HistoryFoldState,
} from "../src/features/conversation/historyFoldPolicy";

const fresh = (): HistoryFoldState => ({
  observed: false,
  completionRevision: null,
});
const input = (patch: Partial<HistoryFoldInput> = {}): HistoryFoldInput => ({
  hasBlocks: true,
  busy: false,
  completionRevision: 0,
  following: true,
  showAll: false,
  failed: false,
  ...patch,
});

test("initial idle history folds once while an initially active Turn stays expanded", () => {
  expect(historyFoldPolicy(fresh(), input()).fold).toBe(true);
  const active = historyFoldPolicy(fresh(), input({ busy: true }));
  expect(active.fold).toBe(false);
  expect(historyFoldPolicy(active.state, input()).fold).toBe(false);
  expect(
    historyFoldPolicy(active.state, input({ completionRevision: 1 })).fold,
  ).toBe(true);
});

test("empty loading state does not consume initial presentation and unknown lifecycle cannot complete a Turn", () => {
  const empty = historyFoldPolicy(fresh(), input({ hasBlocks: false }));
  expect(empty.state).toEqual(fresh());
  expect(empty.fold).toBe(false);
  const unknown = historyFoldPolicy(
    fresh(),
    input({ busy: true, completionRevision: null }),
  );
  expect(historyFoldPolicy(unknown.state, input()).fold).toBe(false);
  expect(
    historyFoldPolicy(unknown.state, input({ completionRevision: null })).fold,
  ).toBe(false);
});

for (const blocker of [
  { busy: true },
  { following: false },
  { showAll: true },
  { failed: true },
]) {
  test(`completion is consumed without deferred folding under ${JSON.stringify(blocker)}`, () => {
    const initial = historyFoldPolicy(fresh(), input({ busy: true }));
    const completed = historyFoldPolicy(
      initial.state,
      input({ completionRevision: 1, ...blocker }),
    );
    expect(completed.fold).toBe(false);
    expect(
      historyFoldPolicy(completed.state, input({ completionRevision: 1 })).fold,
    ).toBe(false);
    expect(
      historyFoldPolicy(completed.state, input({ completionRevision: 2 })).fold,
    ).toBe(true);
  });
}

test("duplicate completion and status-only changes cannot fold an active history", () => {
  let state = historyFoldPolicy(fresh(), input({ busy: true })).state;
  for (const busy of [true, false, true, false]) {
    const decision = historyFoldPolicy(state, input({ busy }));
    expect(decision.fold).toBe(false);
    state = decision.state;
  }
  const completed = historyFoldPolicy(state, input({ completionRevision: 1 }));
  expect(completed.fold).toBe(true);
  expect(
    historyFoldPolicy(completed.state, input({ completionRevision: 1 })).fold,
  ).toBe(false);
});

for (const blocker of [
  { following: false },
  { showAll: true },
  { failed: true },
]) {
  test(`initial history respects retained reading intent ${JSON.stringify(blocker)}`, () => {
    const first = historyFoldPolicy(fresh(), input(blocker));
    expect(first.fold).toBe(false);
    expect(historyFoldPolicy(first.state, input()).fold).toBe(false);
  });
}
