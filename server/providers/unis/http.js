import { readResponseJsonCapped } from '../common/http.js';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/**
 * Fetch the Live Ops snapshot from an internal service (for example a bridge
 * in front of ITEM/Atlas WMS/TMS plus truck telematics).
 *
 * The bearer token stays here on the server; the browser only ever calls
 * /api/unis. The upstream must return the contract in
 * src/layers/unis/records.js; the route normalizes it.
 */
export function createHttpUnisAdapter({
  url,
  token = '',
  fetchImpl = fetch,
  timeoutMs = 10_000,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    parsed = null;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol))
    throw new Error('UNIS_OPS_SNAPSHOT_URL must be an http(s) URL');
  return {
    id: 'http',
    async getSnapshot({ signal } = {}) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      const response = await fetchImpl(parsed, {
        signal: requestSignal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`unis_upstream_http_${response.status}`);
      }
      return readResponseJsonCapped(
        response,
        MAX_SNAPSHOT_BYTES,
        requestSignal,
      );
    },
  };
}
