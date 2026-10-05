import * as Cesium from 'cesium';
import { UNIS_BUENA_PARK } from './site.js';

/**
 * Startup fly-in to UNIS Buena Park (replaces upstream's Austin).
 * Starts high over north Orange County, then descends to an oblique view
 * looking north-north-east across the building.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToUnisBuenaPark(viewer, site = UNIS_BUENA_PARK) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 30000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
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
      duration: 4.5,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
