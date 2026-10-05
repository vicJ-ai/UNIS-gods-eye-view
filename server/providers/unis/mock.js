import { UNIS_BUENA_PARK } from '../../../src/layers/unis/site.js';
import {
  bearingDeg,
  destinationPoint,
  distanceM,
} from '../../../src/layers/unis/records.js';

/**
 * Seeded sample network for the UNIS Live Ops layer.
 *
 * ONLY Buena Park is a real place. Every other facility, customer, shipment
 * and truck here is invented, named `Sample · …`, and flagged `sample: true`
 * so the cards say SAMPLE DATA. Buena Park's own metrics are invented too.
 *
 * The network is seeded by UTC day, so it is stable across polls and
 * restarts within a day. Trucks are placed by wall-clock progress along their
 * lane, so successive polls agree with the browser's dead reckoning.
 */

const DAY_MS = 86_400_000;

// Public reference points: the two port complexes trucks dray from.
const PORT_OF_LA = {
  name: 'Port of Los Angeles',
  lat: 33.7361,
  lon: -118.2626,
};
const PORT_OF_LB = { name: 'Port of Long Beach', lat: 33.7542, lon: -118.2165 };

const SAMPLE_FACILITIES = [
  {
    id: 'sample-ontario',
    name: 'Sample · Ontario DC',
    lat: 34.0559,
    lon: -117.5946,
  },
  {
    id: 'sample-fontana',
    name: 'Sample · Fontana DC',
    lat: 34.0922,
    lon: -117.435,
  },
  {
    id: 'sample-carson',
    name: 'Sample · Carson Cross-dock',
    lat: 33.8317,
    lon: -118.262,
  },
  {
    id: 'sample-dallas',
    name: 'Sample · Dallas DC',
    lat: 32.7357,
    lon: -96.9036,
  },
  {
    id: 'sample-edison',
    name: 'Sample · Edison DC',
    lat: 40.5187,
    lon: -74.4121,
  },
  {
    id: 'sample-savannah',
    name: 'Sample · Savannah DC',
    lat: 32.127,
    lon: -81.172,
  },
  {
    id: 'sample-joliet',
    name: 'Sample · Joliet DC',
    lat: 41.525,
    lon: -88.0817,
  },
];

const SAMPLE_CUSTOMERS = [
  'Sample · Customer A',
  'Sample · Customer B',
  'Sample · Customer C',
  'Sample · Customer D',
  'Sample · Customer E',
];

const SAMPLE_DESTINATIONS = [
  { name: 'Sample · Retail DC Riverside', lat: 33.9533, lon: -117.3962 },
  { name: 'Sample · Retail DC Irvine', lat: 33.6846, lon: -117.8265 },
  { name: 'Sample · Retail DC Phoenix', lat: 33.4484, lon: -112.074 },
  { name: 'Sample · Retail DC Las Vegas', lat: 36.1699, lon: -115.1398 },
  { name: 'Sample · Retail DC San Diego', lat: 32.7157, lon: -117.1611 },
];

/** Small deterministic PRNG (mulberry32). */
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const int = (rand, min, max) => min + Math.floor(rand() * (max - min + 1));

function buenaPark(rand) {
  const docks = 60;
  return {
    id: UNIS_BUENA_PARK.id,
    name: UNIS_BUENA_PARK.name,
    lat: UNIS_BUENA_PARK.lat,
    lon: UNIS_BUENA_PARK.lon,
    kind: 'hq',
    status: 'busy',
    sample: true,
    metrics: {
      inboundToday: int(rand, 40, 90),
      outboundToday: int(rand, 60, 140),
      dockDoorsBusy: int(rand, 30, docks - 4),
      dockDoorsTotal: docks,
      exceptions: int(rand, 0, 4),
    },
  };
}

function sampleFacility(rand, base) {
  const docks = int(rand, 20, 80);
  const exceptions = rand() < 0.2 ? int(rand, 3, 9) : int(rand, 0, 2);
  return {
    ...base,
    kind: 'warehouse',
    status: exceptions >= 3 ? 'exception' : rand() < 0.4 ? 'busy' : 'nominal',
    sample: true,
    metrics: {
      inboundToday: int(rand, 10, 70),
      outboundToday: int(rand, 10, 90),
      dockDoorsBusy: int(rand, 2, docks),
      dockDoorsTotal: docks,
      exceptions,
    },
  };
}

/**
 * A lane's truck position at `nowMs`. Each lane loops on its own period so
 * the map always has traffic; the phase offset staggers trucks on one lane.
 */
function truckOnLane(
  { id, label, origin, destination, speedMps, phase, shipmentId },
  nowMs,
) {
  const length = distanceM(origin, destination);
  const periodMs = Math.max(20 * 60_000, (length / speedMps) * 1000);
  const progress = (((nowMs / periodMs + phase) % 1) + 1) % 1;
  const point = destinationPoint(
    origin,
    bearingDeg(origin, destination),
    length * progress,
  );
  const remainingMs = ((1 - progress) * length * 1000) / speedMps;
  return {
    truck: {
      id,
      label,
      ...point,
      headingDeg: bearingDeg(point, destination),
      speedMps,
      // A real telematics fix arrives every ~30-60 s; stagger the age.
      updatedMs: nowMs - Math.floor(phase * 45_000),
      shipmentId,
      sample: true,
    },
    etaMs: nowMs + remainingMs,
  };
}

/**
 * Build the sample snapshot for `nowMs`.
 * @param {number} nowMs
 * @returns {object} Snapshot in the src/layers/unis/records.js contract.
 */
export function createMockUnisSnapshot(nowMs = Date.now()) {
  const day = Math.floor(nowMs / DAY_MS);
  const rand = seeded(0x756e6973 ^ day); // 'unis'
  const facilities = [
    buenaPark(rand),
    ...SAMPLE_FACILITIES.map((f) => sampleFacility(rand, f)),
  ];
  const hub = {
    name: UNIS_BUENA_PARK.name,
    lat: UNIS_BUENA_PARK.lat,
    lon: UNIS_BUENA_PARK.lon,
  };

  const lanes = [];
  // Inbound drayage: port → Buena Park, several trucks per port.
  for (const port of [PORT_OF_LA, PORT_OF_LB]) {
    const trucks = int(rand, 3, 5);
    for (let i = 0; i < trucks; i++)
      lanes.push({
        direction: 'inbound',
        mode: 'Drayage',
        origin: port,
        destination: hub,
        speedMps: 17 + rand() * 6,
      });
  }
  // Inbound transfers from sample regional DCs.
  for (const f of facilities.slice(1, 4))
    lanes.push({
      direction: 'inbound',
      mode: 'FTL',
      origin: f,
      destination: hub,
      speedMps: 22 + rand() * 5,
    });
  // Outbound to sample customers' DCs and the long-haul sample network.
  for (const d of SAMPLE_DESTINATIONS)
    lanes.push({
      direction: 'outbound',
      mode: pick(rand, ['FTL', 'LTL']),
      origin: hub,
      destination: d,
      speedMps: 22 + rand() * 6,
    });
  for (const f of facilities.slice(4))
    lanes.push({
      direction: 'outbound',
      mode: 'FTL',
      origin: hub,
      destination: f,
      speedMps: 25 + rand() * 4,
    });

  const shipments = [];
  const trucks = [];
  lanes.forEach((lane, index) => {
    const n = String(index + 1).padStart(3, '0');
    const shipmentId = `sample-shp-${day}-${n}`;
    const truckId = `sample-trk-${n}`;
    const { truck, etaMs } = truckOnLane(
      {
        id: truckId,
        label: `Sample · Truck ${n}`,
        origin: lane.origin,
        destination: lane.destination,
        speedMps: lane.speedMps,
        phase: rand(),
        shipmentId,
      },
      nowMs,
    );
    // Every sixth lane runs behind plan, so the map always shows at-risk arcs.
    const atRisk = index % 6 === 2;
    shipments.push({
      id: shipmentId,
      ref: `SAMPLE-${lane.direction === 'inbound' ? 'IB' : 'OB'}-${n}`,
      direction: lane.direction,
      mode: lane.mode,
      status: atRisk ? 'at_risk' : 'in_transit',
      origin: {
        name: lane.origin.name,
        lat: lane.origin.lat,
        lon: lane.origin.lon,
      },
      destination: {
        name: lane.destination.name,
        lat: lane.destination.lat,
        lon: lane.destination.lon,
      },
      // An at-risk load is running behind its plan.
      etaMs: atRisk ? etaMs + int(rand, 45, 180) * 60_000 : etaMs,
      truckId,
      customer: pick(rand, SAMPLE_CUSTOMERS),
      sample: true,
    });
    trucks.push(truck);
  });
  // A few scheduled loads with no truck yet.
  for (let i = 0; i < 4; i++) {
    const d = pick(rand, SAMPLE_DESTINATIONS);
    shipments.push({
      id: `sample-shp-${day}-s${i + 1}`,
      ref: `SAMPLE-OB-S${i + 1}`,
      direction: 'outbound',
      mode: 'LTL',
      status: 'scheduled',
      origin: hub,
      destination: d,
      etaMs: nowMs + int(rand, 6, 30) * 3_600_000,
      truckId: null,
      customer: pick(rand, SAMPLE_CUSTOMERS),
      sample: true,
    });
  }

  return {
    source: 'UNIS sample network (mock)',
    sample: true,
    generatedMs: nowMs,
    facilities,
    shipments,
    trucks,
  };
}

/** Adapter facade: same shape as the HTTP adapter. */
export function createMockUnisAdapter({ now = () => Date.now() } = {}) {
  return {
    id: 'mock',
    async getSnapshot() {
      return createMockUnisSnapshot(now());
    },
  };
}
