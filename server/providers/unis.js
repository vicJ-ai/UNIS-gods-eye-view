import { normalizeUnisSnapshot } from '../../src/layers/unis/records.js';
import { createMockUnisAdapter } from './unis/mock.js';
import { createHttpUnisAdapter } from './unis/http.js';

/** How long one upstream snapshot answers every route. */
const CACHE_MS = 10_000;
/** A failed upstream may be covered by the last good snapshot this long. */
const STALE_MS = 10 * 60_000;

const ROUTES = Object.freeze({
  '/snapshot': ['facilities', 'shipments', 'trucks'],
  '/facilities': ['facilities'],
  '/shipments': ['shipments'],
  '/trucks': ['trucks'],
});

/**
 * Choose the snapshot adapter from server env (UNIS_DATA_SOURCE).
 * @param {object} env
 */
export function createUnisAdapter(env = process.env, { fetchImpl } = {}) {
  const kind = String(env.UNIS_DATA_SOURCE || 'mock')
    .trim()
    .toLowerCase();
  if (kind === 'http')
    return createHttpUnisAdapter({
      url: env.UNIS_OPS_SNAPSHOT_URL,
      token: env.UNIS_OPS_API_TOKEN,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  if (kind !== 'mock')
    throw new Error(`Unknown UNIS_DATA_SOURCE: ${kind} (use mock or http)`);
  return createMockUnisAdapter();
}

/**
 * /api/unis/{snapshot,facilities,shipments,trucks}
 *
 * Every response carries `sample`, `stale` and `unavailable`, so the layer
 * can say honestly what it is drawing.
 */
export function unisOpsProxy({
  env = process.env,
  adapter = null,
  now = () => Date.now(),
} = {}) {
  let resolved = adapter;
  let configError = null;
  let cache = null;
  let inflight = null;

  function getAdapter() {
    if (resolved || configError) return resolved;
    try {
      resolved = createUnisAdapter(env);
    } catch (error) {
      configError = error;
      console.warn(`[UNIS] ${error.message}`);
    }
    return resolved;
  }

  async function acquire() {
    if (cache && now() - cache.fetchedAt < CACHE_MS) return cache;
    if (!inflight) {
      inflight = (async () => {
        const raw = await getAdapter().getSnapshot();
        const snapshot = normalizeUnisSnapshot(raw);
        if (!snapshot) throw new Error('unis_malformed_snapshot');
        cache = { snapshot, fetchedAt: now() };
        return cache;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function describe(entry, fields, { stale = false, reason = null } = {}) {
    const snapshot = entry?.snapshot;
    const body = {
      schemaVersion: 1,
      adapter: resolved?.id ?? null,
      source: snapshot?.source ?? null,
      sample: snapshot?.sample ?? false,
      fetchedAt: entry?.fetchedAt ?? null,
      generatedMs: snapshot?.generatedMs ?? null,
      dropped: snapshot?.dropped ?? 0,
      stale,
      unavailable: !snapshot,
      reason,
    };
    for (const field of fields) body[field] = snapshot?.[field] ?? [];
    return body;
  }

  async function handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path =
      String(req.url || '/')
        .split('?')[0]
        .replace(/\/+$/, '') || '/snapshot';
    const fields = ROUTES[path];
    if (!fields) return json(404, { error: 'unknown_unis_route' });
    if (!getAdapter())
      return json(200, describe(null, fields, { reason: configError.message }));
    try {
      json(200, describe(await acquire(), fields));
    } catch (error) {
      console.warn('[UNIS] snapshot failed:', error?.message || error);
      const usable = cache && now() - cache.fetchedAt <= STALE_MS;
      json(
        200,
        describe(usable ? cache : null, fields, {
          stale: Boolean(usable),
          reason: usable
            ? 'Cached UNIS snapshot; upstream unavailable'
            : 'UNIS ops feed unavailable',
        }),
      );
    }
  }

  return {
    name: 'unis-ops',
    configureServer({ middlewares }) {
      middlewares.use('/api/unis', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/unis', handler);
    },
  };
}
