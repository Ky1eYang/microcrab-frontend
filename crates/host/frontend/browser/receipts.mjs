import { fault } from './workspace.mjs';
export function sameScope(a, b) {
  return a?.scope_version === 3 && b?.scope_version === 3 && a.scope_kind === 'conversation' && b.scope_kind === 'conversation'
    && a.binding_id === b.binding_id && a.backend_id === b.backend_id && a.conversation_id === b.conversation_id;
}
// Settlement records failure for an immutable original intent. It never accepts
// the original payload and cannot replay an effect, including a missing receipt.
export async function settleUnknown(workspace, request, scope, active) {
  if (!sameScope(request.scope, scope) || typeof request.operation_id !== 'string' || !request.operation_id || request.operation_id.length > 256)
    throw fault('operation_conflict', 'Original operation scope changed');
  if (!/^[a-f0-9]{64}$/.test(request.payload_digest)) throw fault('invalid_request', 'Invalid original operation digest');
  if (active?.has(request.operation_id)) throw fault('outcome_unknown', 'Original browser operation is still owned');
  let receipt = await workspace.receipt(request.operation_id);
  const missing = !receipt;
  if (!receipt) receipt = { operation_id: request.operation_id, payload_digest: request.payload_digest, scope, state: { state: 'intent' } };
  if (!sameScope(receipt.scope, scope) || receipt.payload_digest !== request.payload_digest)
    throw fault('operation_conflict', 'Original operation payload or scope changed');
  if (['intent', 'indeterminate'].includes(receipt.state.state)) {
    receipt = { ...receipt, state: { state: 'failed_unknown', result: {
      reason: { code: 'outcome_unknown', message: missing ? 'Original durable receipt is missing; effects may have occurred' : 'Original browser operation has no durable outcome; effects may have occurred' },
      effects_may_have_occurred: true,
    } } };
    await workspace.record(receipt);
  }
  return receipt;
}
