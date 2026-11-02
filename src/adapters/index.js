/**
 * Destination adapter registry. Every candidate is validated by its destination's exact contract
 * before it is stored, and converted to that destination's shape when delivered.
 */
import { destinationById } from '../destinations.js';

/** Validates a full Hub envelope against its destination; returns the destination-shaped candidate. */
export function toDestinationCandidate(envelope) {
  const destination = destinationById(envelope?.destination);
  if (!destination) throw new Error('Invalid Life Hub candidate envelope');
  return destination.adapter(envelope);
}
