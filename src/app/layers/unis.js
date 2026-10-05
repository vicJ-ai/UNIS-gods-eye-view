import { createUnisFacilityLayer } from '../../layers/unis/facility.js';
import { createUnisOpsLayer } from '../../layers/unis/ops.js';
import { createUnisOpsSource } from '../../layers/unis/source.js';
import * as context from '../../data/contextStore.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';
import { governorRequestRender } from '../../renderGovernor.js';
import { overlayHost } from './overlayHost.js';

const render = Object.freeze({ governorRequestRender });

/** UNIS Buena Park: the real building, from OSM. */
export function createApplicationUnisFacility({ surface = null } = {}) {
  return createUnisFacilityLayer({
    terrain: surface?.terrain || null,
    context,
    overlayHost,
    render,
  });
}

/** UNIS Live Ops, fed by the local /api/unis route. */
export function createApplicationUnisOps({
  source = createUnisOpsSource(),
} = {}) {
  return createUnisOpsLayer({
    source,
    context: { ...context, refreshReadout: refreshTrackedReadout },
    overlayHost,
    render,
  });
}
