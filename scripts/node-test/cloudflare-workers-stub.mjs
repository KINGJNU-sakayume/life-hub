/** Minimal stand-in for the `cloudflare:workers` runtime module so Worker code can run under `node --test`. */
export class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export const env = {};
