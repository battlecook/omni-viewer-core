# GeoJSON viewer example

From the repository root:

```sh
npm run build
python3 -m http.server 8080 --bind 127.0.0.1
```

Open [the example](http://127.0.0.1:8080/examples/geojson/) to inspect the sample
or load a local `.geojson` file. Files are processed in the browser; the viewer
does not request basemap tiles or external resources.

`map.geojson` contains all seven geometry types, a polygon with a hole, nested
properties, altitude, and a feature with null geometry. Coordinates are in the
Seoul area; routes, paths, and zones are illustrative, not authoritative GIS
data. Use the toolbar, wheel, or keyboard to zoom and pan. Click a shape or use
the feature selector to inspect its properties.

See [the viewer specification](SPEC.md) for API contracts, format validation,
resource limits, and lifecycle behavior.
