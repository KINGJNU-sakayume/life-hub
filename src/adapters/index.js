/**
 * Destination adapter registry. Every candidate is validated by its destination's exact contract
 * before it is stored, and converted to that destination's shape when delivered.
 */
import { toFoodCandidate } from './food.js';
import { toKyeokyeoiCandidate } from './kyeokyeoi.js';

const ADAPTERS = Object.freeze({ food: toFoodCandidate, kyeokyeoi: toKyeokyeoiCandidate });

/** Validates a full Hub envelope against its destination; returns the destination-shaped candidate. */
export function toDestinationCandidate(envelope) {
  const adapter = ADAPTERS[envelope?.destination];
  if (!adapter) throw new Error('Invalid Life Hub candidate envelope');
  return adapter(envelope);
}
