/**
 * The one real place in the UNIS layers: UNIS, 6800 Valley View St,
 * Buena Park, CA 90620.
 *
 * Footprint and height are OpenStreetMap way 1020037799 (tags: building=yes,
 * height=10.36, source=esri/Orange_County_CA_Buildings_v2). Pure data, no
 * Cesium, so the server mock and the tests can share it.
 */
export const UNIS_BUENA_PARK = Object.freeze({
  id: 'unis-buena-park',
  name: 'UNIS Buena Park',
  shortName: 'UNIS · BUENA PARK',
  address: '6800 Valley View St, Buena Park, CA 90620',
  osmWayId: 1020037799,
  // Footprint centroid; the camera and the beacon aim here.
  lat: 33.86191,
  lon: -118.02609,
  // Approximate orthometric ground elevation, used only when the terrain
  // service cannot resolve the real ellipsoidal floor.
  groundElevationM: 24,
  heightM: 10.36,
  /** Closed [lon, lat] ring, as OSM returns it. */
  footprint: Object.freeze(
    [
      [-118.0275827, 33.8635736],
      [-118.0246019, 33.8635913],
      [-118.024579, 33.8609478],
      [-118.0250548, 33.860945],
      [-118.0250524, 33.8606598],
      [-118.0246439, 33.8606621],
      [-118.0246407, 33.8602791],
      [-118.0275543, 33.8602619],
      [-118.0275827, 33.8635736],
    ].map((pair) => Object.freeze(pair)),
  ),
});

/** Footprint area in m² (equirectangular shoelace; fine at building scale). */
export function footprintAreaM2(ring = UNIS_BUENA_PARK.footprint) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_540;
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * mx * (y2 * my) - x2 * mx * (y1 * my);
  }
  return Math.abs(sum) / 2;
}
