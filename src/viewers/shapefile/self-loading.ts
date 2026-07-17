// Opt-in self-loading entry (ADR 14): the only place in the core where the
// optional peer `proj4` is actually imported. Platforms whose bundler
// resolves the peer use this; others import `viewers/shapefile` and inject
// their own `createReprojector`.

import type { CoordinateConverter } from '../../parsers/shapefile/reproject.js';
import type { ShapefileMountOptions, ShapefileViewerContext } from './index.js';
import { mountShapefileViewer } from './index.js';
import type { ViewerHandle, ViewerInput } from '../types.js';

export * from './index.js';

interface Proj4Like {
    (fromWkt: string, toCrs: string): { forward(position: [number, number]): [number, number] };
}

let proj4Promise: Promise<Proj4Like | null> | undefined;

async function loadProj4(): Promise<Proj4Like | null> {
    proj4Promise ??= import('proj4' as string)
        .then((module) => {
            const mod = module as { default?: Proj4Like };
            return mod.default ?? (module as unknown as Proj4Like);
        })
        .catch(() => null);
    return proj4Promise;
}

/** mountShapefileViewer with a proj4-backed WKT→WGS84 reprojector. Because
 *  mount options are synchronous, proj4 is loaded first; when the peer is
 *  missing the viewer simply renders native coordinates. */
export async function mountSelfLoadingShapefileViewer(
    input: ViewerInput,
    container: HTMLElement,
    ctx: ShapefileViewerContext,
    options: Omit<ShapefileMountOptions, 'createReprojector'> = {}
): Promise<ViewerHandle> {
    const proj4 = await loadProj4();
    const createReprojector = proj4
        ? (wkt: string): CoordinateConverter | null => {
            const transform = proj4(wkt, 'EPSG:4326');
            return (position) => transform.forward([position[0], position[1]]);
        }
        : undefined;
    return mountShapefileViewer(input, container, ctx, {
        ...options,
        ...(createReprojector ? { createReprojector } : {})
    });
}
