# Tel Aviv-Yafo and Rehovot in voxels

Two 1 m voxel dioramas in the MagicaVoxel style, inspired by [stared/warsaw-vibe-voxel](https://github.com/stared/warsaw-vibe-voxel):

- **Tel Aviv-Yafo**: 3.9 × 4.8 km, rotated 14.5° to the street grid. It runs from Old Jaffa and the port north past Rabin Square, and from the sea east to the Azrieli towers, Sarona and the Ayalon.
- **Rehovot**: 3.2 × 3.6 km. It covers the Moshava centre, the Weizmann Institute, the Faculty of Agriculture and the orchards around them.

There's a time-of-day slider (with the real sun position for Israel, lit windows, street lamps and the red aviation lights on the towers) and a month selector (jacaranda purple in April–June, royal poinciana red in May–August, oranges on the citrus in winter).

```sh
cd web && npm install && npm run dev     # http://localhost:5173  (?city=rehovot&view=azrieli&hour=21&month=5&ui=0)
```

## Rebuild the data

```sh
uv run python scripts/fetch.py            # Copernicus DEM tiles (and OSM via Overpass, which is often too busy)
curl -L -o data/raw/israel-and-palestine-latest.osm.pbf https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf
PYTHONPATH=scripts uv run python scripts/osm_pbf.py tlv rehovot   # cut the cities out of the extract (~1 min)
PYTHONPATH=scripts uv run python scripts/build.py tlv rehovot     # ~20 s + ~10 s
```

The output goes to `web/public/data/<city>/`: `meta.json` plus `tiles/{1,2,4,8}/x_y.bin`. That is about 25 MB for Tel Aviv and 15 MB for Rehovot. Fit statistics and counts are written to `data/<city>_report.json`.

To add a city, add an entry to `scripts/cities.py` (centre, size, camera presets), and add its name to `CITIES` in `web/src/main.ts`.

## How it's made (scripts/)

| Step | What |
|---|---|
| Frame | UTM 36N around the centre, rotated to the dominant direction of the building walls, so walls are not staircased |
| Terrain | Copernicus GLO-30 is a *surface* model (roofs included). Ground = the DSM where no building stands, then a ~150 m opening and smoothing |
| Sea | Polygonized from the OSM coastline (water on the right). Depth grows with distance from the shore, with foam at the waterline |
| Heights | OSM `height` / `building:levels` where tagged (~20% of outlines). Elsewhere a fit of log height on the DSM excess over the ground, the footprint area and the median of the tagged neighbours, snapped to whole storeys. Median error on the tagged buildings: ~1 floor |
| Buildings | `building:part`s with `min_height`. Parts stacked on one footprint, as Azrieli Sarona is mapped floor band by floor band, are merged per cell from the lowest bottom to the highest top. Roof shapes (hipped, gabled, pyramidal, domes) from the distance to the footprint edge. Facades: white and cream plaster with windows and balcony bands, kurkar stone in Old Jaffa, glass for towers and tall offices. Construction sites with a tagged height are drawn as raw concrete frames (the Spiral Tower) |
| Tel Aviv details | Parapets, stair rooms and a solar water heater (*dud shemesh*) on the flat roofs. Bauhaus blocks on pilotis (~30% of 3–5 storey apartment blocks, procedural). Sunshades and lifeguard huts on the beaches. Tower cranes over construction sites |
| Streets | Roads by class and lanes, sidewalks, dashed centre lines, zebra crossings at OSM crossings, rails, bridges with ramps and piers, street lamps (OSM plus one every 30 m) |
| Trees | OSM trees and tree rows (only ~200 are mapped), plus procedural ones: street trees along both kerbs, double rows on the *sderot* (boulevards), parks, yards, woods, cemeteries and citrus groves in rows. Species mix: ficus, poinciana, jacaranda, Washingtonia and date palms (near the sea), pines, cypresses, eucalyptus |
| Tiles | 128 × 128 m nodes at 1 m, composed from the 2D layers and the sparse object voxels, then downsampled to 2, 4 and 8 m (`scripts/tiles.py`) |

The viewer (`web/src/`) streams the quadtree (`stream.ts`), greedy-meshes tiles with baked AO in workers (`mesher.worker.ts`), and draws windows, water and the seasons in one shader (`material.ts`). It adds N8AO, bloom and AgX tone mapping on top.

## Known limits

- Most building heights are estimated (see above). Windows are procedural, not real window positions.
- Most trees are procedural: their positions are plausible, not surveyed. The Tel Aviv municipal GIS (which has trees and floor counts) was down for maintenance when this was built; it would be the best next source.
- The 30 m DEM misses the Ayalon trench and small relief. Ground is rounded to whole metres, so gentle slopes show steps.
- Interiors, the underground Red Line, and parked cars are not modelled.

## Sources

- **[OpenStreetMap](https://www.openstreetmap.org/)** © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/), via the [Geofabrik](https://download.geofabrik.de/asia/israel-and-palestine.html) extract.
- **[Copernicus GLO-30 DEM](https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model)** © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA, via the [AWS open data registry](https://registry.opendata.aws/copernicus-dem/).
- Software: [three.js](https://threejs.org/), [postprocessing](https://github.com/pmndrs/postprocessing), [N8AO](https://github.com/N8python/n8ao), [Vite](https://vite.dev/); NumPy, SciPy, Shapely, rasterio, pyproj, pyosmium.

The generated data in `web/public/data` derives from OpenStreetMap and is under the ODbL.
