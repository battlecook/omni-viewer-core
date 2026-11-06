import type { JsonValueKind } from '../json/index.js';
export type OpenApiRefContext = 'reference' | 'pathItem' | 'schema';

/** Shared lossless tree: JSON numbers retain their original spelling. */
export interface OpenApiNode {
    kind: JsonValueKind;
    key: string;
    value?: string | boolean | null;
    rawNumber?: string;
    children?: readonly OpenApiNode[];
    /** Shared resolved view; children retain the referring source definition. */
    referenceTarget?: OpenApiNode;
    referenceContext?: OpenApiRefContext;
}

export interface OpenApiServer { url: string; description: string; }
export interface OpenApiNamedNode { name: string; node: OpenApiNode; }
export interface OpenApiOperation {
    id: string;
    kind: 'path' | 'webhook';
    path: string;
    method: string;
    operationId: string;
    summary: string;
    description: string;
    tags: string[];
    deprecated: boolean;
    parameters: OpenApiNode[];
    requestBody: OpenApiNode | undefined;
    responses: OpenApiNamedNode[];
    security: OpenApiNode | undefined;
    servers: OpenApiServer[];
    consumes: string[];
    produces: string[];
    node: OpenApiNode;
}

export interface OpenApiDocument {
    text: string;
    format: 'json' | 'yaml';
    specVersion: string;
    title: string;
    apiVersion: string;
    description: string;
    servers: OpenApiServer[];
    tags: { name: string; description: string }[];
    operations: OpenApiOperation[];
    schemas: OpenApiNamedNode[];
    securitySchemes: OpenApiNamedNode[];
    root: OpenApiNode;
}
