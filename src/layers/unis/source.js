import { normalizeUnisSnapshot } from './records.js';

/**
 * Browser side of the UNIS Live Ops feed. Only ever calls the local
 * /api/unis route; upstream credentials stay on the server.
 */
export function createUnisOpsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/unis/snapshot',
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(url, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`UNIS ops HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      if (payload?.unavailable)
        throw new Error(payload.reason || 'UNIS ops feed unavailable');
      const snapshot = normalizeUnisSnapshot(payload);
      if (!snapshot) throw new Error('Malformed UNIS ops snapshot');
      return {
        ...snapshot,
        stale: payload.stale === true,
        reason: typeof payload.reason === 'string' ? payload.reason : null,
      };
    },
  };
}
