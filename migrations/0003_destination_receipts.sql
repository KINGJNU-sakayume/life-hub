-- P2b: the destination's own record ID once the owner approves a candidate there (e.g. a PALATE meal id).
ALTER TABLE inbox ADD COLUMN confirmed_entity_id TEXT;
