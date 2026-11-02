/** Resolve hook: map the Workers-only `cloudflare:workers` specifier to a local stub during tests. */
const STUB = new URL('./cloudflare-workers-stub.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
