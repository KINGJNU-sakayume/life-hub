/**
 * Destination adapter registry. Every candidate is validated by its destination's exact contract
 * before it is stored, and converted to that destination's shape when delivered.
 */
import { toFoodCandidate } from './food.js';
import { toKyeokyeoiCandidate } from './kyeokyeoi.js';
import { toPotcastCandidate } from './potcast.js';

const ADAPTERS = Object.freeze({ food: toFoodCandidate, kyeokyeoi: toKyeokyeoiCandidate, potcast: toPotcastCandidate });

/** Validates a full Hub envelope against its destination; returns the destination-shaped candidate. */
export function toDestinationCandidate(envelope) {
  const adapter = ADAPTERS[envelope?.destination];
  if (!adapter) throw new Error('Invalid Life Hub candidate envelope');
  return adapter(envelope);
}
