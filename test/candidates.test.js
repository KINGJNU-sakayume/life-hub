import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueCandidate, candidateIdentity, rejectCandidate, acknowledgeConfirmed, validateHubEnvelope } from '../src/core/candidates.js';
import { toFoodCandidate } from '../src/adapters/food.js';

const meal = () => ({
  hub_version: 1, destination: 'food', source: 'manual',
  source_ref: 'example.20261101', idempotency_key: 'test_meal_0001',
  created_at: '2026-11-01T10:00:00.000Z', candidate_type: 'meal',
  payload: { menu_name: '가상 라멘', place_name: '가상 식당', note: '테스트 기록' },
});
const at = '2026-11-01T10:01:00.000Z';
test('only allow known fields and destination; no transcript or token', () => {
  assert.throws(() => validateHubEnvelope({ ...meal(), raw_conversation: 'private data' }));
  assert.throws(() => validateHubEnvelope({ ...meal(), destination: 'nowhere' }));
  assert.throws(() => validateHubEnvelope({ ...meal(), idempotency_key: 'short' }));
  assert.doesNotThrow(() => validateHubEnvelope(meal()));
});
test('identity is separated by verified tenant and payload is not automatically approved', () => {
  const candidate = meal();
  assert.notEqual(candidateIdentity('user-1', candidate), candidateIdentity('user-2', candidate));
  const received = enqueueCandidate([], 'user-1', candidate, at, toFoodCandidate);
  assert.equal(received.entries[0].status, 'pending');
  assert.equal(received.entries[0].candidate.payload.menu_name, '가상 라멘');
});
test('idempotent retry with same meaning; conflict cannot overwrite', () => {
  const first = enqueueCandidate([], 'user-1', meal(), at, toFoodCandidate);
  const same = { ...meal(), created_at: '2026-11-01T11:00:00Z', source_ref: 'another.ref' };
  assert.equal(enqueueCandidate(first.entries, 'user-1', same, at, toFoodCandidate).duplicate, true);
  assert.throws(() => enqueueCandidate(first.entries, 'user-1', { ...meal(), payload: { menu_name: '다른 음식' } }, at, toFoodCandidate));
});
test('rejection cannot later confirm; ack demands verified destination receipt', () => {
  const first = enqueueCandidate([], 'user-1', meal(), at, toFoodCandidate);
  const rejected = rejectCandidate(first.entries, first.key, at);
  assert.equal(rejected[0].status, 'rejected');
  assert.throws(() => acknowledgeConfirmed(rejected, first.key, { destinationEntityId:'rec-1', receiptVerified:true, reviewedAt:at }));
  assert.throws(() => acknowledgeConfirmed(first.entries, first.key, { destinationEntityId:'rec-1', receiptVerified:false, reviewedAt:at }));
  const confirmed = acknowledgeConfirmed(first.entries, first.key, { destinationEntityId:'rec-1', receiptVerified:true, reviewedAt:at });
  assert.equal(confirmed[0].status, 'confirmed');
  assert.deepEqual(acknowledgeConfirmed(confirmed, first.key, { destinationEntityId:'rec-1', receiptVerified:true, reviewedAt:at }), confirmed);
  assert.throws(() => rejectCandidate(confirmed, first.key, at));
});

test('no queued food candidate may bypass the destination payload validator', () => {
  assert.throws(() => enqueueCandidate([], 'user-1', { ...meal(), payload: { menu_name:'x', api_token:'secret' } }, at, toFoodCandidate));
  assert.throws(() => enqueueCandidate([], 'user-1', meal(), at));
});
