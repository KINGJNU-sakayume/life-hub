-- Rename the `potcast` destination to `music` (2026-11-19; src/destinations.js, `legacy`).
-- Stored proposals, their meaning (its first element is the destination) and envelope, board manifests and
-- reference lists move to the new id. No row is deleted except a board manifest that a newer `music` upload
-- already replaced. Events, card tickets and receipts keep pointing at the same inbox ids.
-- OR IGNORE: a `potcast` row whose key already exists under `music` stays as it is. The code reads both ids
-- during the rollout (and keeps the current one first), so such a row is still served, never lost.

UPDATE OR IGNORE inbox
SET destination = 'music',
    meaning = CASE WHEN substr(meaning, 1, length('["potcast"')) = '["potcast"'
      THEN '["music"' || substr(meaning, length('["potcast"') + 1) ELSE meaning END,
    envelope_json = CASE WHEN json_valid(envelope_json)
      THEN json_set(envelope_json, '$.destination', 'music') ELSE envelope_json END
WHERE destination = 'potcast';

UPDATE OR IGNORE board_manifests SET app = 'music' WHERE app = 'potcast';
DELETE FROM board_manifests WHERE app = 'potcast'
  AND EXISTS (SELECT 1 FROM board_manifests m WHERE m.owner_id = board_manifests.owner_id AND m.app = 'music');

UPDATE OR IGNORE destination_refs SET destination = 'music' WHERE destination = 'potcast';
