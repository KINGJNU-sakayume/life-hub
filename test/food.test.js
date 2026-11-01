import test from 'node:test';
import assert from 'node:assert/strict';
import { toFoodCandidate, validateFoodCandidate } from '../src/adapters/food.js';

const example = ({ candidate_type = 'meal', payload = { menu_name:'가상 라멘' } } = {}) => ({
  hub_version:1, destination:'food', source:'manual', source_ref:'example.001',
  idempotency_key:'test_food_0001', created_at:'2026-11-01T10:00:00Z', candidate_type, payload,
});
test('food adapter emits exact destination v1 shape', () => {
  const f = toFoodCandidate(example());
  assert.equal(f.schema_version, 1);
  assert.equal(f.candidate_type, 'meal');
  assert.equal(f.payload.menu_name, '가상 라멘');
  assert.equal('destination' in f, false);
  assert.equal('hub_version' in f, false);
  assert.deepEqual(validateFoodCandidate(f), f);
});
test('wish candidate keeps place-vs-menu distinction', () => {
  const f = toFoodCandidate(example({ candidate_type:'wish', payload:{wish_kind:'visit_place', name:'가상의 가게'} }));
  assert.equal(f.payload.wish_kind, 'visit_place');
});
test('missing meal date is permitted and not invented', () => {
  const f = toFoodCandidate(example());
  assert.equal(f.payload.eaten_at, undefined);
});
test('reject bad URLs, unknown fields, invalid dates, incorrect verdict', () => {
  assert.throws(() => toFoodCandidate(example({candidate_type:'wish',payload:{wish_kind:'visit_place',name:'x',source_url:'javascript:alert(1)'}})));
  assert.throws(() => toFoodCandidate(example({payload:{menu_name:'x',api_token:'secret'}})));
  assert.throws(() => toFoodCandidate(example({payload:{menu_name:'x',eaten_at:'2026-02-30'}})));
  assert.throws(() => toFoodCandidate(example({payload:{menu_name:'x',verdict:'GOOD'}})));
});
