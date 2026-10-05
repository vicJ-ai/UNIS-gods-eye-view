import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  arcPoints,
  deadReckon,
  facilityCardLines,
  shipmentCardLines,
  truckCardLines,
} from './records.js';

export const UNIS_OPS_LAYER_ID = 'unis-live-ops';
const OVERLAY_SOURCE_ID = 'unis-live-ops';
const TRUCK_TICK_MS = 1000;

/** Arc and truck colors: cyan inbound, amber outbound, red at risk. */
export const UNIS_OPS_COLORS = Object.freeze({
  inbound: '#38e8ff',
  outbound: '#ffb547',
  at_risk: '#ff4d5e',
  scheduled: '#8a96a3',
  nominal: '#5cffb0',
  busy: '#ffb547',
  exception: '#ff4d5e',
});

/** Color key for one shipment. */
export function shipmentColorKey(shipment) {
  if (shipment.status === 'at_risk') return 'at_risk';
  if (shipment.status === 'scheduled' || shipment.status === 'delivered')
    return 'scheduled';
  return shipment.direction;
}

const css = (key) => Cesium.Color.fromCssColorString(UNIS_OPS_COLORS[key]);

/**
 * UNIS Live Ops: facility pins, shipment arcs, and trucks moved by dead
 * reckoning between polls. Everything comes from /api/unis; in mock mode the
 * cards say SAMPLE DATA.
 */
export function createUnisOpsLayer({
  source,
  context,
  overlayHost,
  render = null,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('UNIS Live Ops requires a snapshot source');
  if (!context?.registerEntityContext)
    throw new TypeError('UNIS Live Ops requires the context services');
  if (!overlayHost)
    throw new TypeError('UNIS Live Ops requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let clickHandler = null;
  let ticker = null;
  let request = null;
  let enabled = false;
  let snapshot = null;
  let lastUpdate = null;
  let lastError = null;
  let selectedKey = null;
  const entityByKey = new Map();

  function requestRender() {
    render?.governorRequestRender?.('unis-live-ops');
    viewer?.scene?.requestRender?.();
  }

  function contextFor(
    entity,
    key,
    { title, details, accent, label, lat, lon, kind, properties },
  ) {
    entity.gevUnisOps = key;
    entity.gevTrackedId = `${UNIS_OPS_LAYER_ID}:${key}`;
    entity.gevLabelModel = { title, details, accent };
    context.registerEntityContext(entity, {
      id: `${UNIS_OPS_LAYER_ID}:${key}`,
      layerId: UNIS_OPS_LAYER_ID,
      layerName: 'UNIS Live Ops',
      source: snapshot?.sample
        ? 'UNIS sample network'
        : snapshot?.source || 'UNIS ops',
      label,
      latitude: lat,
      longitude: lon,
      dataSource,
      properties: { kind, ...properties },
    });
    entityByKey.set(key, entity);
  }

  function addFacility(facility) {
    const color = css(facility.status);
    const position = Cesium.Cartesian3.fromDegrees(
      facility.lon,
      facility.lat,
      0,
    );
    const entity = dataSource.entities.add({
      id: `unis-ops:facility:${facility.id}`,
      position,
      point: {
        pixelSize: facility.kind === 'hq' ? 15 : 11,
        color: color.withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => position;
    contextFor(entity, `facility:${facility.id}`, {
      title: facility.name.toUpperCase(),
      details: facilityCardLines(facility),
      accent: UNIS_OPS_COLORS[facility.status],
      label: facility.name,
      lat: facility.lat,
      lon: facility.lon,
      kind: 'facility',
      properties: { status: facility.status, metrics: facility.metrics },
    });
  }

  function addShipment(shipment, nowMs) {
    const key = shipmentColorKey(shipment);
    const color = css(key);
    const points = arcPoints(shipment.origin, shipment.destination);
    const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
      points.flatMap((p) => [p.lon, p.lat, p.heightM]),
    );
    const selected = selectedKey === `shipment:${shipment.id}`;
    const entity = dataSource.entities.add({
      id: `unis-ops:shipment:${shipment.id}`,
      polyline: {
        positions,
        width: selected ? 6 : shipment.status === 'at_risk' ? 4 : 3,
        arcType: Cesium.ArcType.NONE,
        material:
          key === 'scheduled'
            ? new Cesium.PolylineDashMaterialProperty({
                color: color.withAlpha(0.55),
                dashLength: 12,
              })
            : new Cesium.PolylineGlowMaterialProperty({
                glowPower: selected ? 0.3 : 0.18,
                color: color.withAlpha(selected ? 1 : 0.85),
              }),
      },
    });
    const apex = positions[Math.floor(positions.length / 2)];
    entity.gevDisplayPosition = () => apex;
    const mid = points[Math.floor(points.length / 2)];
    contextFor(entity, `shipment:${shipment.id}`, {
      title: shipment.ref,
      details: shipmentCardLines(shipment, nowMs),
      accent: UNIS_OPS_COLORS[key],
      label: shipment.ref,
      lat: mid.lat,
      lon: mid.lon,
      kind: 'shipment',
      properties: {
        status: shipment.status,
        direction: shipment.direction,
        etaMs: shipment.etaMs,
        customer: shipment.customer,
      },
    });
  }

  function addTruck(truck, shipment) {
    const key = shipment ? shipmentColorKey(shipment) : 'scheduled';
    const destination = shipment?.destination || null;
    const scratch = new Cesium.Cartesian3();
    const current = () => {
      const p = deadReckon(truck, now(), destination);
      return Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0, undefined, scratch);
    };
    const entity = dataSource.entities.add({
      id: `unis-ops:truck:${truck.id}`,
      position: new Cesium.CallbackPositionProperty(current, false),
      point: {
        pixelSize: 8,
        color: Cesium.Color.WHITE,
        outlineColor: css(key),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevDisplayPosition = () => Cesium.Cartesian3.clone(current());
    contextFor(entity, `truck:${truck.id}`, {
      title: truck.label.toUpperCase(),
      details: truckCardLines(truck, shipment, now()),
      accent: UNIS_OPS_COLORS[key],
      label: truck.label,
      lat: truck.lat,
      lon: truck.lon,
      kind: 'truck',
      properties: { shipmentId: truck.shipmentId, speedMps: truck.speedMps },
    });
    entity.gevUnisTruck = { truck, shipment };
  }

  function publishLabels() {
    if (!enabled || !snapshot) return;
    const entries = snapshot.facilities
      .filter((f) => f.kind !== 'hq') // the facility layer labels Buena Park
      .map((f) => ({
        id: `facility:${f.id}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 30),
        variant: 'label',
        title: f.name.replace(/^Sample · /, '').toUpperCase(),
        accent: UNIS_OPS_COLORS[f.status],
        priority: 10_000 + (f.metrics.outboundToday || 0),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 10,
        verticalOnly: true,
        placement: 'above',
      }));
    overlayHost.setEntries(OVERLAY_SOURCE_ID, entries, {
      cohortLimit: 24,
      collisionCapacity: 24,
      moving: false,
    });
    overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
  }

  function renderSnapshot() {
    if (!dataSource || !snapshot) return;
    const nowMs = now();
    const shipmentById = new Map(snapshot.shipments.map((s) => [s.id, s]));
    const entities = dataSource.entities;
    entities.suspendEvents();
    entities.removeAll();
    entityByKey.clear();
    for (const shipment of snapshot.shipments)
      if (shipment.status !== 'delivered') addShipment(shipment, nowMs);
    for (const facility of snapshot.facilities) addFacility(facility);
    for (const truck of snapshot.trucks)
      addTruck(
        truck,
        truck.shipmentId ? shipmentById.get(truck.shipmentId) : null,
      );
    entities.resumeEvents();
    context.removeEntityContextsForLayer?.(UNIS_OPS_LAYER_ID, {
      retainIds: new Set(
        [...entityByKey.keys()].map((k) => `${UNIS_OPS_LAYER_ID}:${k}`),
      ),
    });
    if (selectedKey) {
      const entity = entityByKey.get(selectedKey);
      if (entity) context.selectEntityContext(entity);
      else selectedKey = null;
    }
    publishLabels();
    requestRender();
  }

  /** Keep moving trucks' cards and positions fresh between polls. */
  function tick() {
    if (!enabled || !snapshot?.trucks.length) return;
    if (selectedKey?.startsWith('truck:')) {
      const entity = entityByKey.get(selectedKey);
      const info = entity?.gevUnisTruck;
      if (info) {
        entity.gevLabelModel = {
          ...entity.gevLabelModel,
          details: truckCardLines(info.truck, info.shipment, now()),
        };
        context.refreshReadout?.(entity);
      }
    }
    requestRender();
  }

  function select(key) {
    const entity = entityByKey.get(key);
    if (!entity) return false;
    const previous = selectedKey;
    selectedKey = key;
    // Arcs restyle on selection; pins and trucks do not need a rebuild.
    if (key.startsWith('shipment:') || previous?.startsWith('shipment:'))
      renderSnapshot();
    else context.selectEntityContext(entity);
    return true;
  }

  function deselect() {
    if (!selectedKey) return;
    const wasShipment = selectedKey.startsWith('shipment:');
    selectedKey = null;
    context.clearSelectedEntityContextForLayer?.(UNIS_OPS_LAYER_ID);
    if (wasShipment) renderSnapshot();
  }

  const layer = {
    id: UNIS_OPS_LAYER_ID,
    name: 'UNIS Live Ops',
    icon: '⇄',
    get source() {
      if (!snapshot) return 'UNIS · /api/unis';
      return snapshot.sample ? 'UNIS · SAMPLE DATA' : 'UNIS · LIVE';
    },
    updateInterval: 15_000,

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(UNIS_OPS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((click) => {
        if (!enabled || !isPointerFree()) return;
        const key = viewer.scene.pick(click.position)?.id?.gevUnisOps;
        if (key && key !== selectedKey) select(key);
        else deselect();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      if (snapshot) renderSnapshot();
      ticker ??= setInterval(tick, TRUCK_TICK_MS);
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      clearInterval(ticker);
      ticker = null;
      selectedKey = null;
      context.clearSelectedEntityContextForLayer?.(UNIS_OPS_LAYER_ID);
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      requestRender();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const own = new AbortController();
      request = own;
      try {
        const next = await source.getSnapshot({ signal: own.signal });
        if (own.signal.aborted || request !== own || !enabled) return false;
        snapshot = next;
        lastUpdate = now();
        lastError = next.stale ? next.reason || 'Stale UNIS snapshot' : null;
        renderSnapshot();
        console.log(
          `[Data:UNIS] ${next.facilities.length} facilities, ${next.shipments.length} shipments, ${next.trucks.length} trucks${next.sample ? ' (sample)' : ''}`,
        );
        return true;
      } catch (error) {
        if (own.signal.aborted || request !== own || !enabled) return false;
        console.warn('[Data:UNIS] Fetch error:', error);
        lastError = error?.message || 'UNIS ops feed unavailable';
        return false;
      } finally {
        if (request === own) request = null;
      }
    },

    /** Snapshot currently drawn (for the tests and the debug console). */
    getSnapshot() {
      return snapshot;
    },

    destroy(v = viewer) {
      request?.abort();
      clearInterval(ticker);
      ticker = null;
      clickHandler?.destroy();
      clickHandler = null;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      context.removeEntityContextsForLayer?.(UNIS_OPS_LAYER_ID);
      if (dataSource) v?.dataSources.remove(dataSource, true);
      dataSource = null;
      entityByKey.clear();
      snapshot = null;
      viewer = null;
      enabled = false;
    },

    getStats() {
      return {
        count: snapshot
          ? snapshot.facilities.length +
            snapshot.shipments.length +
            snapshot.trucks.length
          : 0,
        lastUpdate,
        error: lastError,
        stale: snapshot?.stale === true,
        sample: snapshot?.sample === true,
      };
    },
  };
  return layer;
}
