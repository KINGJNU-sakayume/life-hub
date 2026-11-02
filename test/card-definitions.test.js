import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_STYLE, CARD_COMPONENTS, CARD_DEFINITIONS, cardDefinitionFor, canAutoApply } from '../src/mcp/cards/definitions.js';
import { DESTINATIONS } from '../src/destinations.js';
import { TOOLS } from '../src/mcp/tools.js';

test('card registry has unique domain/context identities and shared design tokens', () => {
  assert.ok(CARD_STYLE.version > 0);
  assert.ok(CARD_STYLE.width.compact < CARD_STYLE.width.standard);
  assert.ok(CARD_COMPONENTS.includes('card-shell') && CARD_COMPONENTS.includes('action-footer'));
  assert.equal(new Set(CARD_DEFINITIONS.map(c => c.id)).size, CARD_DEFINITIONS.length);
  for (const card of CARD_DEFINITIONS) {
    assert.equal(card.id, card.destination + '.' + card.candidateType);
    assert.ok(card.title && card.variant && card.fields.length);
    assert.ok(['existing', 'planned'].includes(card.phase));
    assert.deepEqual(cardDefinitionFor(card.destination, card.candidateType), card);
  }
  assert.equal(cardDefinitionFor('invalid', 'whatever'), null);
});

test('active card definitions cover existing destination proposal variants without enabling planned writes', () => {
  for (const destination of DESTINATIONS) {
    const definitions = CARD_DEFINITIONS.filter(c => c.destination === destination.id && c.phase === 'existing');
    assert.ok(definitions.length > 0, destination.id);
    for (const candidateType of destination.types) {
      assert.ok(definitions.some(c => c.candidateType === candidateType), destination.id + ' ' + candidateType);
    }
  }
  const advertised = TOOLS.map(t => t.name);
  for (const planned of CARD_DEFINITIONS.filter(c => c.phase === 'planned')) {
    assert.ok(!advertised.includes('propose_' + planned.candidateType), planned.id);
  }
  assert.ok(!advertised.some(name => /approve|reject|edit|autocommit|auto_apply/.test(name)));
});

test('auto-apply policy fails closed unless every owner, version, ambiguity and reference gate passes', () => {
  const reading = cardDefinitionFor('letterbookxd', 'reading_record');
  assert.equal(canAutoApply({}, reading), false);
  assert.equal(canAutoApply({ ownerApproved:true, autoApplyEnabled:true, sourceVersionCurrent:true }, reading), false);
  assert.equal(canAutoApply({
    ownerApproved:true, autoApplyEnabled:true, sourceVersionCurrent:true,
    dependenciesResolved:['edition-id'], ambiguous:true,
  }, reading), false);
  assert.equal(canAutoApply({
    ownerApproved:true, autoApplyEnabled:true, sourceVersionCurrent:true,
    dependenciesResolved:['edition-id'],
  }, reading), true);
  assert.equal(canAutoApply({
    ownerApproved:true, autoApplyEnabled:true, sourceVersionCurrent:true,
  }, cardDefinitionFor('achievement', 'achievement_definition')), false);
  assert.equal(canAutoApply({
    ownerApproved:true, autoApplyEnabled:true, sourceVersionCurrent:true,
  }, null), false);
  assert.equal(canAutoApply({
    ownerApproved:true, autoApplyEnabled:false, sourceVersionCurrent:true,
    dependenciesResolved:['edition-id'],
  }, reading), false);
});
