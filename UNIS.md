# UNIS God's Eye

A personal/exploratory fork of [bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)
(MIT) centred on **UNIS, 6800 Valley View St, Buena Park, CA 90620**. The `upstream` git remote points
at the original project.

## Run it

```sh
npm ci
npm run dev        # http://localhost:4173
```

The app opens with a fly-in to the Buena Park building, and both UNIS layers are switched on.
Optional free keys go in `.env` (template: `.env.example`) or the in-app **POWER UP** panel:

| Key | What it unlocks |
| --- | --- |
| `CESIUM_ION_TOKEN` (Cesium ion, free) | Photorealistic 3D city instead of flat Esri imagery |
| `AISSTREAM_API_KEY` (free) | Live ships at the Ports of LA / Long Beach |
| `TOMTOM_API_KEY` (free tier) | Live I-5 / SR-91 traffic speeds |

The free Cesium ion / Google 3D tier is for
personal, non-commercial use. Using this at work needs Google Map Tiles API billing or a Cesium
commercial plan.

## What this fork adds

| Piece | Where |
| --- | --- |
| **UNIS Buena Park** layer: glowing building volume, roofline and beacon, plus an info card. The footprint comes from OSM way 1020037799 | `src/layers/unis/facility.js`, `site.js` |
| **UNIS Live Ops** layer: facility network pins and cards, shipment arcs (cyan inbound, amber outbound, red at-risk), trucks moved by dead reckoning between polls | `src/layers/unis/ops.js`, `records.js`, `source.js` |
| `/api/unis/{snapshot,facilities,shipments,trucks}` server feed | `server/providers/unis.js`, `server/providers/unis/` |
| Startup fly-in to Buena Park (replaces Austin) | `src/layers/unis/camera.js`, `src/app/controls.js` |
| **SoCal · UNIS** location preset (Buena Park, both ports, I-5/SR-91, Fullerton airport) | `src/locations.js` |
| **UNIS Buena Park: Port to Dock** cinematic scene (Scenes panel) | `src/scenes/recipes.js` |
| UNIS layers turned on at every boot | `src/layers/unis/defaults.js`, `src/app/tools.js` |

The UNIS layers are registered as `local-only`, like the hardware ADS-B layer. They are never written
into share-link tokens or the upstream token ledger, so pulling upstream changes cannot collide with them.

## Live ops data

`UNIS_DATA_SOURCE` (server env) selects the adapter:

- `mock` (default): a seeded sample network. **Only Buena Park is real.** Every other facility,
  customer, shipment and truck is invented and labelled `Sample ·` / `SAMPLE DATA`.
- `http`: fetches `UNIS_OPS_SNAPSHOT_URL` (with an optional `UNIS_OPS_API_TOKEN` bearer token). The
  upstream must return the snapshot contract normalized in `src/layers/unis/records.js`:

```jsonc
{
  "facilities": [{ "id", "name", "lat", "lon", "kind": "hq|warehouse", "status": "nominal|busy|exception",
                   "metrics": { "inboundToday", "outboundToday", "dockDoorsBusy", "dockDoorsTotal", "exceptions" } }],
  "shipments":  [{ "id", "ref", "direction": "inbound|outbound", "mode", "status": "scheduled|in_transit|at_risk|delivered",
                   "origin": { "name", "lat", "lon" }, "destination": { … }, "etaMs", "truckId", "customer" }],
  "trucks":     [{ "id", "label", "lat", "lon", "headingDeg", "speedMps", "updatedMs", "shipmentId" }]
}
```

The intended next step is a small bridge service that turns ITEM/Atlas WMS/TMS data, plus truck
telematics GPS, into this shape. Credentials stay on the server. The browser only ever calls `/api/unis`.

## Tests

```sh
node --test src/layers/unis/unis.test.mjs   # UNIS unit tests
npm test                                    # full upstream suite
npm run check:boundaries && npm run build
```

Upstream test edits, kept small: `src/app/constructCatalog.test.mjs` (layer count 29 → 31) and
`src/scenes/scenePolicy.test.mjs` (adds the two UNIS ids to the test's registered-layer set).
