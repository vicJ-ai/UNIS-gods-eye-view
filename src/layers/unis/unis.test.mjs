// UNIS fork: snapshot contract, dead reckoning, the sample network, the
// /api/unis route, and the layers' pure presentation.
//
// Run with: node --test src/layers/unis/unis.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIS_BUENA_PARK, footprintAreaM2 } from './site.js';
import {
  UNIS_DEAD_RECKON_MAX_MS,
  arcPoints,
  deadReckon,
  distanceM,
  etaLabel,
  normalizeUnisSnapshot,
  truckCardLines,
} from './records.js';
import { createUnisOpsSource } from './source.js';
import { facilityCardModel } from './facility.js';
import { shipmentColorKey } from './ops.js';
import { UNIS_DEFAULT_LAYER_IDS, enableUnisDefaultLayers } from './defaults.js';
import { createMockUnisSnapshot } from '../../../server/providers/unis/mock.js';
import { createHttpUnisAdapter } from '../../../server/providers/unis/http.js';
import {
  createUnisAdapter,
  unisOpsProxy,
} from '../../../server/providers/unis.js';
import { CITY_POIS } from '../../locations.js';
import { getSceneRecipeById } from '../../scenes/recipes.js';

const NOW = Date.UTC(2026, 9, 5, 17, 0, 0);

const facility = (over = {}) => ({
  id: 'f1',
  name: 'F1',
  lat: 33.9,
  lon: -118,
  kind: 'warehouse',
  status: 'busy',
  metrics: {
    inboundToday: 3,
    outboundToday: 4,
    dockDoorsBusy: 9,
    dockDoorsTotal: 5,
    exceptions: 0,
  },
  ...over,
});
const shipment = (over = {}) => ({
  id: 's1',
  ref: 'S-1',
  direction: 'inbound',
  mode: 'FTL',
  status: 'in_transit',
  origin: { name: 'A', lat: 33.75, lon: -118.2 },
  destination: { name: 'B', lat: 33.86, lon: -118.03 },
  etaMs: NOW + 3_600_000,
  truckId: 't1',
  customer: 'C',
  ...over,
});
const truck = (over = {}) => ({
  id: 't1',
  label: 'T1',
  lat: 33.8,
  lon: -118.1,
  headingDeg: 90,
  speedMps: 20,
  updatedMs: NOW,
  shipmentId: 's1',
  ...over,
});

test('the site is OSM way 1020037799 and its centroid sits inside the footprint', () => {
  const site = UNIS_BUENA_PARK;
  assert.equal(site.osmWayId, 1020037799);
  assert.deepEqual(site.footprint[0], site.footprint.at(-1), 'ring is closed');
  const lons = site.footprint.map(([lon]) => lon);
  const lats = site.footprint.map(([, lat]) => lat);
  assert.ok(site.lon > Math.min(...lons) && site.lon < Math.max(...lons));
  assert.ok(site.lat > Math.min(...lats) && site.lat < Math.max(...lats));
  // ~277 m x ~368 m with one notch: roughly 100,000 m².
  const area = footprintAreaM2();
  assert.ok(area > 90_000 && area < 110_000, `area ${area}`);
});

test('a valid snapshot normalizes; bad rows are dropped and counted, not guessed', () => {
  const snapshot = normalizeUnisSnapshot({
    facilities: [
      facility(),
      facility({ id: 'f1' }),
      facility({ id: 'bad', lat: 200 }),
    ],
    shipments: [shipment(), shipment({ id: 's2', direction: 'sideways' })],
    trucks: [
      truck(),
      truck({ id: 't2', updatedMs: null }),
      truck({ id: 't3', speedMps: 900 }),
    ],
  });
  assert.equal(snapshot.facilities.length, 1);
  assert.equal(snapshot.shipments.length, 1);
  assert.equal(snapshot.trucks.length, 2);
  assert.equal(snapshot.dropped, 4);
  // Busy docks never exceed total docks.
  assert.equal(snapshot.facilities[0].metrics.dockDoorsBusy, 5);
  // An implausible speed is not trusted for dead reckoning.
  assert.equal(snapshot.trucks.find((t) => t.id === 't3').speedMps, 0);
});

test('non-snapshots are rejected outright', () => {
  for (const value of [null, [], 'x', 3, {}, { facilities: 'no' }])
    assert.equal(normalizeUnisSnapshot(value), null, JSON.stringify(value));
});

test('text from an upstream cannot carry markup or control characters', () => {
  const snapshot = normalizeUnisSnapshot({
    facilities: [facility({ name: '<img src=x onerror=alert(1)>\u0007Dock' })],
  });
  assert.equal(snapshot.facilities[0].name, 'img src=x onerror=alert(1)Dock');
});

test('dead reckoning extrapolates along heading, caps its age, and never overshoots', () => {
  const t = normalizeUnisSnapshot({ trucks: [truck()] }).trucks[0];
  const oneMin = deadReckon(t, NOW + 60_000);
  assert.ok(Math.abs(distanceM(t, oneMin) - 1200) < 2, 'moves speed x time');
  assert.ok(
    oneMin.lon > t.lon && Math.abs(oneMin.lat - t.lat) < 1e-3,
    'heading 90 goes east',
  );
  const stale = deadReckon(t, NOW + 60 * 60_000);
  assert.equal(stale.extrapolatedMs, UNIS_DEAD_RECKON_MAX_MS);
  const destination = { lat: t.lat, lon: t.lon + 0.001 };
  const capped = deadReckon(t, NOW + 5 * 60_000, destination);
  assert.ok(distanceM(capped, destination) < 1, 'stops at the destination');
  assert.deepEqual(deadReckon({ ...t, speedMps: 0 }, NOW + 60_000), {
    lat: t.lat,
    lon: t.lon,
    extrapolatedMs: 0,
  });
});

test('arcs start and end on the ground and lift in between', () => {
  const s = shipment();
  const points = arcPoints(s.origin, s.destination);
  assert.equal(points[0].heightM, 0);
  assert.ok(Math.abs(points.at(-1).heightM) < 1e-6);
  assert.equal(points.at(-1).lat, s.destination.lat);
  assert.ok(points[16].heightM >= 1500);
});

test('the sample network is deterministic, valid, and labelled sample', () => {
  const a = createMockUnisSnapshot(NOW);
  const b = createMockUnisSnapshot(NOW);
  assert.deepEqual(a, b);
  const snapshot = normalizeUnisSnapshot(a);
  assert.equal(snapshot.dropped, 0);
  assert.equal(snapshot.sample, true);
  assert.ok(snapshot.shipments.some((s) => s.status === 'at_risk'));
  assert.ok(snapshot.shipments.some((s) => s.direction === 'inbound'));
  assert.ok(snapshot.shipments.some((s) => s.direction === 'outbound'));
  for (const f of snapshot.facilities) {
    assert.equal(f.sample, true);
    if (f.id !== UNIS_BUENA_PARK.id) assert.match(f.name, /^Sample · /);
  }
  for (const t of snapshot.trucks) assert.match(t.label, /^Sample · /);
  const shipmentIds = new Set(snapshot.shipments.map((s) => s.id));
  for (const t of snapshot.trucks) assert.ok(shipmentIds.has(t.shipmentId));
});

test('sample trucks move consistently between polls', () => {
  const before = createMockUnisSnapshot(NOW).trucks[0];
  const after = createMockUnisSnapshot(NOW + 30_000).trucks[0];
  const moved = distanceM(before, after);
  const expected = before.speedMps * 30;
  assert.ok(
    Math.abs(moved - expected) < expected * 0.05,
    `${moved} vs ${expected}`,
  );
});

function fakeRequest(plugin, url, method = 'GET') {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          body: JSON.parse(body),
        });
      },
    };
    handler({ method, url }, res);
  });
}

test('/api/unis serves each route from one cached snapshot', async () => {
  let calls = 0;
  const plugin = unisOpsProxy({
    adapter: {
      id: 'test',
      getSnapshot: async () => (calls++, createMockUnisSnapshot(NOW)),
    },
    now: () => NOW,
  });
  const snapshot = await fakeRequest(plugin, '/snapshot');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers['Cache-Control'], 'no-store');
  assert.equal(snapshot.body.sample, true);
  assert.ok(snapshot.body.trucks.length > 0);
  const trucks = await fakeRequest(plugin, '/trucks');
  assert.deepEqual(
    Object.keys(trucks.body).filter((k) => Array.isArray(trucks.body[k])),
    ['trucks'],
  );
  assert.equal(calls, 1);
  assert.equal((await fakeRequest(plugin, '/nope')).status, 404);
  assert.equal((await fakeRequest(plugin, '/snapshot', 'POST')).status, 405);
});

test('/api/unis covers an outage with the last good snapshot, then says unavailable', async () => {
  let clock = NOW;
  let fail = false;
  const plugin = unisOpsProxy({
    adapter: {
      id: 'test',
      getSnapshot: async () => {
        if (fail) throw new Error('down');
        return createMockUnisSnapshot(NOW);
      },
    },
    now: () => clock,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fakeRequest(plugin, '/snapshot');
    fail = true;
    clock += 60_000;
    const stale = await fakeRequest(plugin, '/snapshot');
    assert.equal(stale.body.stale, true);
    assert.ok(stale.body.facilities.length > 0);
    clock += 60 * 60_000;
    const gone = await fakeRequest(plugin, '/snapshot');
    assert.equal(gone.body.unavailable, true);
    assert.deepEqual(gone.body.facilities, []);
  } finally {
    console.warn = warn;
  }
});

test('adapter selection follows UNIS_DATA_SOURCE and refuses bad config', () => {
  assert.equal(createUnisAdapter({}).id, 'mock');
  assert.equal(createUnisAdapter({ UNIS_DATA_SOURCE: 'MOCK' }).id, 'mock');
  assert.equal(
    createUnisAdapter({
      UNIS_DATA_SOURCE: 'http',
      UNIS_OPS_SNAPSHOT_URL: 'https://example.test/s',
    }).id,
    'http',
  );
  assert.throws(
    () => createUnisAdapter({ UNIS_DATA_SOURCE: 'http' }),
    /UNIS_OPS_SNAPSHOT_URL/,
  );
  assert.throws(
    () => createUnisAdapter({ UNIS_DATA_SOURCE: 'ftp' }),
    /Unknown UNIS_DATA_SOURCE/,
  );
});

test('the HTTP adapter sends the bearer token server-side and rejects HTTP errors', async () => {
  const seen = [];
  const adapter = createHttpUnisAdapter({
    url: 'https://example.test/snapshot',
    token: 'secret-token',
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ facilities: [] }), { status: 200 });
    },
  });
  assert.deepEqual(await adapter.getSnapshot(), { facilities: [] });
  assert.equal(seen[0].init.headers.Authorization, 'Bearer secret-token');
  assert.equal(seen[0].init.redirect, 'error');
  const failing = createHttpUnisAdapter({
    url: 'https://example.test/snapshot',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  await assert.rejects(failing.getSnapshot(), /unis_upstream_http_503/);
});

test('the browser source refuses an unavailable feed and keeps stale flags', async () => {
  const respond = (body) => async () =>
    new Response(JSON.stringify(body), { status: 200 });
  await assert.rejects(
    createUnisOpsSource({
      fetchImpl: respond({ unavailable: true, reason: 'down' }),
    }).getSnapshot(),
    /down/,
  );
  const stale = await createUnisOpsSource({
    fetchImpl: respond({
      ...createMockUnisSnapshot(NOW),
      stale: true,
      reason: 'cached',
    }),
  }).getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.sample, true);
});

test('cards say what they are, including SAMPLE DATA', () => {
  const card = facilityCardModel();
  assert.equal(card.title, 'UNIS · BUENA PARK');
  assert.ok(card.details.includes(UNIS_BUENA_PARK.address));
  assert.match(card.details[1], /^~1\.\d\dM sq ft footprint · 10\.4 m roof$/);
  const [t] = normalizeUnisSnapshot({
    trucks: [truck({ sample: true })],
  }).trucks;
  const lines = truckCardLines(t, null, NOW + 30_000);
  assert.equal(lines[0], '45 mph · HDG 90°');
  assert.match(lines[2], /30s ago/);
  assert.equal(lines.at(-1), 'SAMPLE DATA');
  assert.equal(etaLabel(NOW + 90 * 60_000, NOW), 'ETA 90 min');
  assert.equal(etaLabel(NOW - 3 * 3_600_000, NOW), '3.0 h late');
});

test('arc colors: inbound, outbound, at risk, scheduled', () => {
  assert.equal(shipmentColorKey(shipment()), 'inbound');
  assert.equal(
    shipmentColorKey(shipment({ direction: 'outbound' })),
    'outbound',
  );
  assert.equal(shipmentColorKey(shipment({ status: 'at_risk' })), 'at_risk');
  assert.equal(
    shipmentColorKey(shipment({ status: 'scheduled' })),
    'scheduled',
  );
});

test('both UNIS layers are enabled at boot, and a missing layer is skipped', async () => {
  const enabled = [];
  const dataManager = {
    layers: new Map([['unis-buena-park', {}]]),
    setEnabled: async (id, value, options) => {
      enabled.push([id, value, options.origin]);
      return true;
    },
  };
  await enableUnisDefaultLayers(dataManager);
  assert.deepEqual(UNIS_DEFAULT_LAYER_IDS, [
    'unis-buena-park',
    'unis-live-ops',
  ]);
  assert.deepEqual(enabled, [['unis-buena-park', true, 'programmatic']]);
});

test('the SoCal preset opens on Buena Park and the scene ends there', () => {
  const socal = CITY_POIS.socal;
  assert.equal(socal.pois[0].name, 'UNIS Buena Park');
  assert.equal(socal.pois[0].lat, UNIS_BUENA_PARK.lat);
  const scene = getSceneRecipeById('unis-port-to-dock');
  assert.deepEqual(
    Object.entries(scene.layers)
      .filter(([, on]) => on)
      .map(([id]) => id),
    ['unis-buena-park', 'unis-live-ops'],
  );
  const last = scene.cameraPath.at(-1);
  assert.ok(distanceM(last, UNIS_BUENA_PARK) < 1500);
});
