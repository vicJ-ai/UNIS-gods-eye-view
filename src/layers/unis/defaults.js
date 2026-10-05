import { UNIS_FACILITY_LAYER_ID } from './facility.js';
import { UNIS_OPS_LAYER_ID } from './ops.js';

/** The UNIS layers this fork switches on at every boot. */
export const UNIS_DEFAULT_LAYER_IDS = Object.freeze([
  UNIS_FACILITY_LAYER_ID,
  UNIS_OPS_LAYER_ID,
]);

/**
 * Turn the UNIS layers on. They are local-only (never in share links or
 * stored layer state), so nothing restores them; this does, every boot.
 * @param {{setEnabled: Function, layers: Map}} dataManager
 */
export function enableUnisDefaultLayers(dataManager) {
  return Promise.all(
    UNIS_DEFAULT_LAYER_IDS.filter((id) => dataManager?.layers?.has(id)).map(
      (id) =>
        dataManager
          .setEnabled(id, true, { origin: 'programmatic' })
          .catch((error) => {
            console.warn(`[UNIS] could not enable ${id}:`, error);
            return false;
          }),
    ),
  );
}
