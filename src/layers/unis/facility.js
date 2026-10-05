import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { UNIS_BUENA_PARK, footprintAreaM2 } from './site.js';

export const UNIS_FACILITY_LAYER_ID = 'unis-buena-park';
export const UNIS_ACCENT = '#38e8ff';
const OVERLAY_SOURCE_ID = 'unis-buena-park';
const BEACON_HEIGHT_M = 160;
// EGM96 undulation at Buena Park; used only if the terrain service is absent.
const GEOID_FALLBACK_M = -35.5;

/** Card text for the building. Pure, so the tests can read it. */
export function facilityCardModel(site = UNIS_BUENA_PARK) {
  const sqft = Math.round(footprintAreaM2(site.footprint) * 10.7639);
  const area =
    sqft >= 1_000_000
      ? `${(sqft / 1_000_000).toFixed(2)}M`
      : `${Math.round(sqft / 1000)}k`;
  return {
    title: site.shortName,
    details: [
      site.address,
      `~${area} sq ft footprint · ${site.heightM.toFixed(1)} m roof`,
      `OSM way ${site.osmWayId}`,
    ],
    accent: UNIS_ACCENT,
  };
}

/**
 * The UNIS Buena Park building: a glowing volume over the real OSM
 * footprint, a bright roofline, a vertical beacon, an ambient label, and a
 * click card through the shared tracked-readout lane.
 */
export function createUnisFacilityLayer({
  terrain = null,
  context,
  overlayHost,
  render = null,
  site = UNIS_BUENA_PARK,
} = {}) {
  if (!context?.registerEntityContext || !context?.selectEntityContext)
    throw new TypeError('UNIS facility requires the context services');
  if (!overlayHost)
    throw new TypeError('UNIS facility requires an overlay host');

  let viewer = null;
  let dataSource = null;
  let clickHandler = null;
  let enabled = false;
  let selected = false;
  let groundM = site.groundElevationM + GEOID_FALLBACK_M;
  let groundSource = 'fallback';
  let groundRequest = null;
  let cardEntity = null;
  let lastError = null;

  const accent = Cesium.Color.fromCssColorString(UNIS_ACCENT);
  const ring = site.footprint.slice(0, -1);
  const roofCenter = () =>
    Cesium.Cartesian3.fromDegrees(site.lon, site.lat, groundM + site.heightM);

  function requestRender() {
    render?.governorRequestRender?.('unis-facility');
    viewer?.scene?.requestRender?.();
  }

  function build() {
    if (!dataSource) return;
    const entities = dataSource.entities;
    entities.suspendEvents();
    entities.removeAll();
    const roof = groundM + site.heightM;
    const flat = ring.flat();
    const volume = entities.add({
      id: `${UNIS_FACILITY_LAYER_ID}:volume`,
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
        height: groundM,
        extrudedHeight: roof,
        material: accent.withAlpha(selected ? 0.42 : 0.26),
        outline: false,
      },
    });
    const outline = (height, width, glow) =>
      entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            site.footprint.flatMap(([lon, lat]) => [lon, lat, height]),
          ),
          width,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: glow,
            color: accent.withAlpha(0.95),
          }),
          arcType: Cesium.ArcType.NONE,
        },
      });
    const roofline = outline(roof + 0.4, selected ? 9 : 6, 0.3);
    const baseline = outline(groundM + 0.6, 3, 0.15);
    const beacon = entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([
          site.lon,
          site.lat,
          roof,
          site.lon,
          site.lat,
          roof + BEACON_HEIGHT_M,
        ]),
        width: 10,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.35,
          taperPower: 0.6,
          color: accent.withAlpha(0.9),
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });
    const beaconTop = entities.add({
      position: Cesium.Cartesian3.fromDegrees(
        site.lon,
        site.lat,
        roof + BEACON_HEIGHT_M,
      ),
      point: {
        pixelSize: 11,
        color: Cesium.Color.WHITE,
        outlineColor: accent,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    for (const entity of [volume, roofline, baseline, beacon, beaconTop])
      entity.gevUnisFacility = true;
    entities.resumeEvents();

    // The volume carries the click card.
    cardEntity = volume;
    const roofPosition = roofCenter();
    volume.gevTrackedId = `${UNIS_FACILITY_LAYER_ID}:${site.osmWayId}`;
    volume.gevDisplayPosition = () => roofPosition;
    volume.gevLabelModel = { ...facilityCardModel(site), selected };
    context.registerEntityContext(volume, {
      id: `${UNIS_FACILITY_LAYER_ID}:site`,
      layerId: UNIS_FACILITY_LAYER_ID,
      layerName: 'UNIS Buena Park',
      source: `OpenStreetMap way ${site.osmWayId}`,
      label: site.name,
      latitude: site.lat,
      longitude: site.lon,
      dataSource,
      properties: {
        address: site.address,
        heightM: site.heightM,
        osmWayId: site.osmWayId,
        groundSource,
      },
    });
    publishLabel();
    requestRender();
  }

  function publishLabel() {
    if (!enabled) return;
    overlayHost.setEntries(
      OVERLAY_SOURCE_ID,
      selected
        ? []
        : [
            {
              id: 'unis-buena-park',
              position: Cesium.Cartesian3.fromDegrees(
                site.lon,
                site.lat,
                groundM + site.heightM + BEACON_HEIGHT_M,
              ),
              variant: 'label',
              title: site.shortName,
              accent: UNIS_ACCENT,
              priority: 1_000_000,
              collisionGroup: 'ambient-label',
              paintLane: 'ambient-label',
              interactive: false,
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
              gapPx: 12,
              verticalOnly: true,
              placement: 'above',
            },
          ],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
    overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
  }

  async function resolveGround() {
    if (!terrain?.resolveEllipsoidalGround || groundSource === 'reearth')
      return;
    groundRequest?.abort();
    const request = new AbortController();
    groundRequest = request;
    try {
      const [result] = await terrain.resolveEllipsoidalGround(
        [
          {
            lat: site.lat,
            lon: site.lon,
            sourceOrthometricM: site.groundElevationM,
          },
        ],
        { signal: request.signal },
      );
      if (request.signal.aborted || !Number.isFinite(result?.ellipsoid)) return;
      groundM = result.ellipsoid;
      groundSource = result.source || 'resolved';
      lastError = null;
      if (enabled) build();
    } catch (error) {
      if (!request.signal.aborted)
        lastError = error?.message || 'Ground height unavailable';
    } finally {
      if (groundRequest === request) groundRequest = null;
    }
  }

  function select() {
    selected = true;
    build();
    context.selectEntityContext(cardEntity);
  }

  function deselect() {
    if (!selected) return;
    selected = false;
    context.clearSelectedEntityContextForLayer?.(UNIS_FACILITY_LAYER_ID);
    build();
  }

  const layer = {
    id: UNIS_FACILITY_LAYER_ID,
    name: 'UNIS Buena Park',
    icon: '◆',
    source: 'UNIS · OSM',

    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(UNIS_FACILITY_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((click) => {
        if (!enabled || !isPointerFree()) return;
        const picked = viewer.scene.pick(click.position);
        if (picked?.id?.gevUnisFacility) {
          if (selected) deselect();
          else select();
        } else deselect();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      build();
      void resolveGround();
    },

    disable() {
      enabled = false;
      selected = false;
      groundRequest?.abort();
      context.clearSelectedEntityContextForLayer?.(UNIS_FACILITY_LAYER_ID);
      if (dataSource) dataSource.show = false;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      requestRender();
    },

    // Static geometry: nothing to poll. The lifecycle still calls update().
    async update() {
      return enabled;
    },

    /** Fly to the building and open its card. */
    focus({ duration = 2.5 } = {}) {
      if (!viewer) return false;
      if (enabled) select();
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          site.lon - 0.0042,
          site.lat - 0.0068,
          520,
        ),
        orientation: {
          heading: Cesium.Math.toRadians(25),
          pitch: Cesium.Math.toRadians(-32),
          roll: 0,
        },
        duration,
      });
      return true;
    },

    destroy(v = viewer) {
      groundRequest?.abort();
      clickHandler?.destroy();
      clickHandler = null;
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      context.removeEntityContextsForLayer?.(UNIS_FACILITY_LAYER_ID);
      if (dataSource) v?.dataSources.remove(dataSource, true);
      dataSource = null;
      cardEntity = null;
      viewer = null;
      enabled = false;
    },

    getStats() {
      return {
        count: enabled ? 1 : 0,
        lastUpdate: null,
        error: lastError,
        ground: groundSource,
      };
    },
  };
  return layer;
}
