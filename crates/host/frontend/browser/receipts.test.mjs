import test from 'node:test';
import assert from 'node:assert/strict';
import { settleUnknown } from './receipts.mjs';
const scope = { scope_version: 3, scope_kind: 'conversation', binding_id: 'binding', backend_id: 'backend', conversation_id: 'conversation' };
const request = { operation_id: 'original', payload_digest: 'a'.repeat(64), scope };
function store(initial) { let value = initial; return { receipt: async () => value, record: async receipt => { value = receipt; }, value: () => value }; }
test('missing original receipt is durably fenced as failure without an executable payload', async () => {
  const workspace = store();
  const result = await settleUnknown(workspace, request, scope, new Set());
  assert.equal(result.state.state, 'failed_unknown');
  assert.equal(result.state.result.effects_may_have_occurred, true);
  assert.equal(workspace.value(), result);
  assert.equal(await settleUnknown(workspace, request, scope, new Set()), result);
});
test('crashed intent settles but live owner and changed identity remain fenced', async () => {
  const workspace = store({ ...request, state: { state: 'intent' } });
  await assert.rejects(settleUnknown(workspace, request, scope, new Set(['original'])), /still owned/);
  await assert.rejects(settleUnknown(workspace, { ...request, payload_digest: 'b'.repeat(64) }, scope), /payload or scope/);
  await assert.rejects(settleUnknown(workspace, { ...request, scope: { ...scope, binding_id: 'other' } }, scope), /scope changed/);
  assert.equal(workspace.value().state.state, 'intent');
  assert.equal((await settleUnknown(workspace, request, scope)).state.state, 'failed_unknown');
});
