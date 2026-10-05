/**
 * UNIS Live Ops snapshot contract, shared by the server feed and the browser.
 *
 * Any adapter behind /api/unis (the seeded mock, or an HTTP bridge in front of
 * ITEM/Atlas WMS/TMS plus truck telematics) must produce this shape:
 *
 *   {
 *     facilities: [{ id, name, lat, lon, kind: 'hq'|'warehouse',
 *                    status: 'nominal'|'busy'|'exception',
 *                    metrics: { inboundToday, outboundToday, dockDoorsBusy,
 *                               dockDoorsTotal, exceptions } }],
 *     shipments:  [{ id, ref, direction: 'inbound'|'outbound', mode,
 *                    status: 'scheduled'|'in_transit'|'at_risk'|'delivered',
 *                    origin: { name, lat, lon }, destination: { name, lat, lon },
 *                    etaMs, truckId, customer }],
 *     trucks:     [{ id, label, lat, lon, headingDeg, speedMps, updatedMs,
 *                    shipmentId }]
 *   }
 *
 * Normalization is per-row: a malformed row is dropped and counted, never
 * guessed at, so one bad record from an upstream cannot blank the whole map.
 * Pure: no Cesium, no DOM.
 */

export const UNIS_FACILITY_KINDS = Object.freeze(['hq', 'warehouse']);
export const UNIS_FACILITY_STATUSES = Object.freeze([
  'nominal',
  'busy',
  'exception',
]);
export const UNIS_SHIPMENT_DIRECTIONS = Object.freeze(['inbound', 'outbound']);
export const UNIS_SHIPMENT_STATUSES = Object.freeze([
  'scheduled',
  'in_transit',
  'at_risk',
  'delivered',
]);

/** Snapshot caps; an upstream larger than this is truncated, not rejected. */
export const UNIS_LIMITS = Object.freeze({
  facilities: 200,
  shipments: 2000,
  trucks: 2000,
});

/** Dead reckoning stops extrapolating after this long without a fix. */
export const UNIS_DEAD_RECKON_MAX_MS = 10 * 60_000;

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

function text(value, max = 120) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const out = String(value)
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim();
  return out ? out.slice(0, max) : null;
}

function finite(value, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function count(value) {
  const n = finite(value, 0, 1e7);
  return n === null ? null : Math.round(n);
}

function oneOf(value, allowed, fallback = null) {
  const key = String(value ?? '')
    .trim()
    .toLowerCase();
  return allowed.includes(key) ? key : fallback;
}

/** `{ lat, lon }` on Earth, or null. */
function coordinate(row) {
  const lat = finite(row?.lat, -90, 90);
  const lon = finite(row?.lon, -180, 180);
  return lat === null || lon === null ? null : { lat, lon };
}

function place(row) {
  const point = coordinate(row);
  if (!point) return null;
  return { name: text(row?.name) || 'Unnamed stop', ...point };
}

/** @returns {object|null} One normalized facility, or null when unusable. */
export function normalizeUnisFacility(row) {
  const id = text(row?.id, 64);
  const point = coordinate(row);
  if (!id || !point) return null;
  const metrics =
    row?.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const dockDoorsTotal = count(metrics.dockDoorsTotal);
  let dockDoorsBusy = count(metrics.dockDoorsBusy);
  if (dockDoorsBusy !== null && dockDoorsTotal !== null)
    dockDoorsBusy = Math.min(dockDoorsBusy, dockDoorsTotal);
  return {
    id,
    name: text(row?.name) || id,
    ...point,
    kind: oneOf(row?.kind, UNIS_FACILITY_KINDS, 'warehouse'),
    status: oneOf(row?.status, UNIS_FACILITY_STATUSES, 'nominal'),
    sample: row?.sample === true,
    metrics: {
      inboundToday: count(metrics.inboundToday),
      outboundToday: count(metrics.outboundToday),
      dockDoorsBusy,
      dockDoorsTotal,
      exceptions: count(metrics.exceptions),
    },
  };
}

/** @returns {object|null} One normalized shipment, or null when unusable. */
export function normalizeUnisShipment(row) {
  const id = text(row?.id, 64);
  const origin = place(row?.origin);
  const destination = place(row?.destination);
  const direction = oneOf(row?.direction, UNIS_SHIPMENT_DIRECTIONS);
  if (!id || !origin || !destination || !direction) return null;
  return {
    id,
    ref: text(row?.ref, 64) || id,
    direction,
    mode: text(row?.mode, 32) || 'FTL',
    status: oneOf(row?.status, UNIS_SHIPMENT_STATUSES, 'scheduled'),
    origin,
    destination,
    etaMs: finite(row?.etaMs, 0),
    truckId: text(row?.truckId, 64),
    customer: text(row?.customer),
    sample: row?.sample === true,
  };
}

/** @returns {object|null} One normalized truck fix, or null when unusable. */
export function normalizeUnisTruck(row) {
  const id = text(row?.id, 64);
  const point = coordinate(row);
  const updatedMs = finite(row?.updatedMs, 0);
  if (!id || !point || updatedMs === null) return null;
  const heading = finite(row?.headingDeg);
  return {
    id,
    label: text(row?.label, 64) || id,
    ...point,
    headingDeg: heading === null ? null : ((heading % 360) + 360) % 360,
    // 60 m/s (~134 mph) bounds a road vehicle; anything faster is a bad fix.
    speedMps: finite(row?.speedMps, 0, 60) ?? 0,
    updatedMs,
    shipmentId: text(row?.shipmentId, 64),
    sample: row?.sample === true,
  };
}

function normalizeList(rows, normalize, limit) {
  const out = [];
  const ids = new Set();
  let dropped = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (out.length >= limit) {
      dropped++;
      continue;
    }
    const record = normalize(row);
    if (!record || ids.has(record.id)) {
      dropped++;
      continue;
    }
    ids.add(record.id);
    out.push(record);
  }
  return { rows: out, dropped };
}

/**
 * Validate an upstream snapshot.
 * @param {object} payload Raw adapter output.
 * @returns {{facilities: object[], shipments: object[], trucks: object[],
 *   dropped: number, sample: boolean, generatedMs: number|null}|null}
 *   null only when the payload is not a snapshot at all.
 */
export function normalizeUnisSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  if (
    !Array.isArray(payload.facilities) &&
    !Array.isArray(payload.shipments) &&
    !Array.isArray(payload.trucks)
  )
    return null;
  const facilities = normalizeList(
    payload.facilities,
    normalizeUnisFacility,
    UNIS_LIMITS.facilities,
  );
  const shipments = normalizeList(
    payload.shipments,
    normalizeUnisShipment,
    UNIS_LIMITS.shipments,
  );
  const trucks = normalizeList(
    payload.trucks,
    normalizeUnisTruck,
    UNIS_LIMITS.trucks,
  );
  return {
    facilities: facilities.rows,
    shipments: shipments.rows,
    trucks: trucks.rows,
    dropped: facilities.dropped + shipments.dropped + trucks.dropped,
    sample: payload.sample === true,
    source: text(payload.source, 80),
    generatedMs: finite(payload.generatedMs, 0),
  };
}

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached from `start` after `meters` along `headingDeg`. */
export function destinationPoint(start, headingDeg, meters) {
  const δ = meters / EARTH_RADIUS_M;
  const θ = toRad(headingDeg);
  const φ1 = toRad(start.lat);
  const λ1 = toRad(start.lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Where a truck probably is now, between polls.
 *
 * Extrapolates the last fix along its heading at its reported speed, capped
 * at UNIS_DEAD_RECKON_MAX_MS so a truck that stops reporting freezes instead
 * of driving off into the ocean. When the truck's shipment destination is
 * known, it never overshoots it.
 * @param {object} truck Normalized truck.
 * @param {number} nowMs Wall clock.
 * @param {{lat:number, lon:number}} [destination] Shipment destination.
 * @returns {{lat:number, lon:number, extrapolatedMs:number}}
 */
export function deadReckon(truck, nowMs, destination = null) {
  const elapsed = Math.min(
    UNIS_DEAD_RECKON_MAX_MS,
    Math.max(0, nowMs - truck.updatedMs),
  );
  if (!truck.speedMps || truck.headingDeg === null || elapsed === 0)
    return { lat: truck.lat, lon: truck.lon, extrapolatedMs: 0 };
  let meters = (truck.speedMps * elapsed) / 1000;
  if (destination) meters = Math.min(meters, distanceM(truck, destination));
  return {
    ...destinationPoint(truck, truck.headingDeg, meters),
    extrapolatedMs: elapsed,
  };
}

/**
 * Sample a shipment arc between two places: great-circle in plan, with a
 * sine-shaped lift whose apex scales with distance (clamped), so short
 * drayage hops stay low and cross-country lanes read as long arcs.
 * @returns {Array<{lat:number, lon:number, heightM:number}>}
 */
export function arcPoints(origin, destination, segments = 32) {
  const meters = distanceM(origin, destination);
  const apexM = Math.min(120_000, Math.max(1_500, meters * 0.18));
  const heading = bearingDeg(origin, destination);
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const point =
      i === segments
        ? { lat: destination.lat, lon: destination.lon }
        : destinationPoint(origin, heading, meters * t);
    points.push({ ...point, heightM: Math.sin(Math.PI * t) * apexM });
  }
  return points;
}

const SHIPMENT_STATUS_LABELS = Object.freeze({
  scheduled: 'SCHEDULED',
  in_transit: 'IN TRANSIT',
  at_risk: 'AT RISK',
  delivered: 'DELIVERED',
});

/** Short, honest ETA phrase relative to now. */
export function etaLabel(etaMs, nowMs = Date.now()) {
  if (!Number.isFinite(etaMs)) return 'ETA —';
  const minutes = Math.round((etaMs - nowMs) / 60_000);
  if (Math.abs(minutes) < 1) return 'ETA now';
  const span =
    Math.abs(minutes) < 120
      ? `${Math.abs(minutes)} min`
      : `${(Math.abs(minutes) / 60).toFixed(1)} h`;
  return minutes > 0 ? `ETA ${span}` : `${span} late`;
}

/** Card lines for a facility pin. */
export function facilityCardLines(facility) {
  const m = facility.metrics;
  const dash = (n) => (n === null ? '—' : n.toLocaleString('en-US'));
  return [
    `${facility.kind === 'hq' ? 'HQ' : 'WAREHOUSE'} · ${facility.status.toUpperCase()}`,
    `IN ${dash(m.inboundToday)} · OUT ${dash(m.outboundToday)} today`,
    `DOCKS ${dash(m.dockDoorsBusy)}/${dash(m.dockDoorsTotal)} busy`,
    `EXCEPTIONS ${dash(m.exceptions)}`,
    ...(facility.sample ? ['SAMPLE DATA'] : []),
  ];
}

/** Card lines for a shipment arc. */
export function shipmentCardLines(shipment, nowMs = Date.now()) {
  return [
    `${shipment.direction.toUpperCase()} · ${shipment.mode} · ${SHIPMENT_STATUS_LABELS[shipment.status]}`,
    `${shipment.origin.name} → ${shipment.destination.name}`,
    ...(shipment.customer ? [shipment.customer] : []),
    etaLabel(shipment.etaMs, nowMs),
    ...(shipment.sample ? ['SAMPLE DATA'] : []),
  ];
}

/** Card lines for a truck. */
export function truckCardLines(truck, shipment, nowMs = Date.now()) {
  const mph = Math.round(truck.speedMps * 2.23694);
  const ageS = Math.max(0, Math.round((nowMs - truck.updatedMs) / 1000));
  return [
    `${mph} mph${truck.headingDeg === null ? '' : ` · HDG ${Math.round(truck.headingDeg)}°`}`,
    shipment
      ? `${shipment.ref} · ${SHIPMENT_STATUS_LABELS[shipment.status]}`
      : 'No shipment',
    `Fix ${ageS < 90 ? `${ageS}s` : `${Math.round(ageS / 60)} min`} ago · dead reckoned`,
    ...(truck.sample ? ['SAMPLE DATA'] : []),
  ];
}
