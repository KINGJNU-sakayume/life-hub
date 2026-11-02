/**
 * MCP tools exposed to an authorized Claude connection.
 *
 * Every tool only PROPOSES a candidate into the private inbox (status: pending) or reads the status
 * of a candidate this connector proposed. Nothing here can approve, confirm, edit or delete records,
 * and nothing writes to PALATE directly.
 */
import { canonical } from '../core/candidates.js';
import { insertCandidate, getCandidate, StoreFailure } from '../server/store.js';

const SOURCE = 'claude';
const NOT_A_RECORD = 'Saved as a PENDING proposal only. It becomes a real record only after the owner reviews and approves it in PALATE.';

const mealSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['menu_name'],
  properties: {
    menu_name: { type: 'string', minLength: 1, maxLength: 200, description: 'Dish or menu item exactly as the user named it.' },
    place_name: { type: 'string', minLength: 1, maxLength: 200, description: 'Restaurant or place, only if the user said it.' },
    eaten_on: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Date the meal was actually eaten (YYYY-MM-DD, user\'s local date). Only if the user stated or clearly implied it ("today", "last night"); never guess.' },
    verdict: { type: 'string', enum: ['LIKE', 'NEUTRAL', 'DISLIKE'], description: 'Only if the user expressed how it was.' },
    reorder_intent: { type: 'string', enum: ['YES', 'MAYBE', 'NO'], description: 'Only if the user said whether they would order it again.' },
    note: { type: 'string', minLength: 1, maxLength: 1000, description: 'Short note in the user\'s own words. Do not paste the conversation.' },
  },
};
const wishSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['wish_kind', 'name'],
  properties: {
    wish_kind: { type: 'string', enum: ['visit_place', 'try_menu'], description: 'visit_place for a restaurant/place, try_menu for a dish.' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    source_url: { type: 'string', maxLength: 2048, pattern: '^https://', description: 'Optional https link the user shared.' },
    note: { type: 'string', minLength: 1, maxLength: 1000 },
  },
};

/** Deterministic order, as MCP recommends for client-side caching. */
export const TOOLS = Object.freeze([
  {
    name: 'get_food_candidate_status',
    title: 'Check a food proposal',
    description: 'Look up the review status (pending, rejected, confirmed) of a food proposal previously made through this connector, by the candidate_id that propose_food_meal or propose_food_wish returned.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['candidate_id'],
      properties: { candidate_id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'propose_food_meal',
    title: 'Propose a meal for PALATE',
    description: 'Propose a meal the user has ACTUALLY eaten, for later review in their PALATE food log. Use only when the user explicitly says they ate it. Do NOT use for plans, wishes, hypotheticals, recipes, or meals they did not eat. Fill only fields the user stated. ' + NOT_A_RECORD + ' Identical proposals are de-duplicated.',
    inputSchema: mealSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'propose_food_wish',
    title: 'Propose a food wish for PALATE',
    description: 'Propose a place the user wants to visit or a dish they want to try, for later review in their PALATE wishlist. Use only when the user says they want to go or try it. ' + NOT_A_RECORD + ' Identical proposals are de-duplicated.',
    inputSchema: wishSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

export class ToolInputError extends Error {}

function pick(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolInputError('Arguments must be an object.');
  const allowed = Object.keys(schema.properties);
  const unknown = Object.keys(args).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new ToolInputError(`Unknown field(s): ${unknown.join(', ')}.`);
  for (const key of schema.required) if (args[key] === undefined) throw new ToolInputError(`Missing required field: ${key}.`);
  const out = {};
  for (const key of allowed) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== 'string') throw new ToolInputError(`${key} must be a string.`);
    const value = args[key].trim();
    if (!value) throw new ToolInputError(`${key} must not be empty.`);
    out[key] = value;
  }
  return out;
}

async function idempotencyKey(candidateType, payload) {
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify([SOURCE, candidateType, canonical(payload)])));
  return 'mcp-' + [...new Uint8Array(digest)].slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function propose(context, candidateType, payload) {
  const createdAt = new Date(context.now()).toISOString();
  const envelope = {
    hub_version: 1, destination: 'food', source: SOURCE,
    source_ref: 'claude-mcp:' + createdAt.slice(0, 10),
    idempotency_key: await idempotencyKey(candidateType, payload),
    created_at: createdAt, candidate_type: candidateType, payload,
  };
  let result;
  try {
    result = await insertCandidate(context.db, context.ownerId, envelope, createdAt);
  } catch (error) {
    if (error instanceof StoreFailure) throw error;
    // Adapter validation failures carry no user data; report them as fixable input errors.
    if (/Invalid (Life Hub|PALATE)|Unsupported PALATE/.test(String(error?.message)))
      throw new ToolInputError('The proposal did not pass PALATE validation. Check field formats (dates as YYYY-MM-DD, https links).');
    throw error;
  }
  const structured = { candidate_id: result.id, status: result.status, duplicate: result.duplicate };
  const text = result.duplicate ?
    `An identical proposal is already in the inbox (candidate_id ${result.id}, status ${result.status}). Nothing new was added. If this is a different occasion, include the date (eaten_on) or a distinguishing note.` :
    `Proposal saved for review (candidate_id ${result.id}, status pending). ${NOT_A_RECORD}`;
  return { text, structured };
}

/** Returns { content, structuredContent, isError? }. Throws only for server faults. */
export async function callTool(name, args, context) {
  try {
    let outcome;
    if (name === 'propose_food_meal') {
      const p = pick(args, mealSchema);
      const payload = { menu_name: p.menu_name };
      for (const key of ['place_name', 'verdict', 'reorder_intent', 'note']) if (p[key] !== undefined) payload[key] = p[key];
      if (p.eaten_on !== undefined) payload.eaten_at = p.eaten_on;
      outcome = await propose(context, 'meal', payload);
    } else if (name === 'propose_food_wish') {
      outcome = await propose(context, 'wish', pick(args, wishSchema));
    } else if (name === 'get_food_candidate_status') {
      const { candidate_id: id } = pick(args, TOOLS[0].inputSchema);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new ToolInputError('candidate_id must be the id returned by a propose tool.');
      const found = await getCandidate(context.db, context.ownerId, id, SOURCE);
      if (!found) throw new ToolInputError('No proposal with that candidate_id was made through this connector.');
      const structured = { candidate_id: found.id, status: found.status, received_at: found.received_at, reviewed_at: found.reviewed_at ?? null };
      outcome = { text: `Candidate ${found.id} is ${found.status}.`, structured };
    } else {
      return null;
    }
    return { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured };
  } catch (error) {
    if (error instanceof ToolInputError || (error instanceof StoreFailure && error.status === 409)) {
      const text = error instanceof StoreFailure ? 'A conflicting proposal already uses this key.' : error.message;
      return { content: [{ type: 'text', text }], isError: true };
    }
    throw error;
  }
}
