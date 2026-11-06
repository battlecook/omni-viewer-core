export const apiObject = () => ({
    openapi: '3.1.0',
    info: { title: 'Pet API', version: '1.2.0', description: 'Pets and their owners.' },
    servers: [{ url: 'https://api.example.test/v1', description: 'Production' }],
    tags: [{ name: 'pets', description: 'Pet endpoints' }],
    security: [{ bearer: [] }],
    paths: {
        '/pets/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                { name: 'expand', in: 'query', schema: { type: 'boolean' } }],
            get: { operationId: 'getPet', tags: ['pets'], summary: 'Find a pet', description: 'Return a pet by ID.',
                parameters: [{ name: 'expand', in: 'query', description: 'Override', schema: { type: 'string' } }],
                responses: { '200': { $ref: '#/components/responses/Pet' } } },
            delete: { operationId: 'deletePet', tags: ['pets'], deprecated: true, security: [], responses: { '204': { description: 'Deleted' } } }
        },
        '/pets': {
            post: { summary: 'Create a pet', tags: ['pets'], requestBody: { $ref: '#/components/requestBodies/Pet' },
                servers: [{ url: 'https://write.example.test' }], responses: { '201': { description: 'Created' } } }
        }
    },
    webhooks: { petChanged: { post: { summary: 'Pet changed', responses: { '200': { description: 'Received' } } } } },
    components: {
        schemas: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'integer', format: 'int64' },
            name: { type: 'string', description: 'Pet name' }, owner: { $ref: '#/components/schemas/Pet' } } } },
        responses: { Pet: { description: 'A pet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' }, example: { id: 1, name: 'Milo' } } } } },
        requestBodies: { Pet: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
        securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
    }
});
export const apiJson = () => JSON.stringify(apiObject());
export const apiYaml = `# YAML API definition
---
openapi: 3.1.0
info:
  title: Pet API
  version: '1.2.0'
  description: |
    A multiline description.
    openapi: this is nested text
paths:
  /pets:
    get:
      summary: List pets
      tags: [pets]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    Pet:
      type: object
      properties:
        name:
          type: string
`;
export const swaggerYaml = `swagger: '2.0'
info: {"title": "Legacy API", "version": "1.0"}
host: legacy.example.test
basePath: /v2
schemes: [https, http]
consumes: [application/json]
produces: [application/json]
securityDefinitions:
  apiKey:
    type: apiKey
    name: X-API-Key
    in: header
definitions:
  Pet:
    type: object
    properties:
      name: {type: string}
paths:
  /pets:
    post:
      parameters:
        - name: pet
          in: body
          required: true
          schema:
            $ref: '#/definitions/Pet'
      responses:
        '200':
          description: Created
          schema:
            $ref: '#/definitions/Pet'
`;
