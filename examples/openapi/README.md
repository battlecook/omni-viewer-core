# OpenAPI / Swagger examples

- `petstore.json`: OpenAPI 3.1 with CRUD operations, parameter inheritance,
  request/response schemas, examples and bearer authentication.
- `petstore.yaml`: OpenAPI 3.1 YAML with comments and a multiline description.
- `swagger.yaml`: Swagger 2.0 with legacy host/schemes, a body parameter,
  response definitions and API key authentication.
- `generic.json` and `generic.yaml`: ordinary data that stays in the existing
  JSON/YAML viewer despite containing a nested `openapi` setting.

Build the core and serve the repository root:

```sh
npm run build
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/examples/openapi/` and select a sample or a local
JSON/YAML file. The demo uses complete-content detection with injected YAML
dependencies and mounts either OpenAPI or the existing JSON/YAML viewer. All
dependencies and samples are loaded from this repository; no CDN is used.

See the [viewer contract](../../docs/viewers/openapi.md) for exports, resource
limits and reference behavior.
