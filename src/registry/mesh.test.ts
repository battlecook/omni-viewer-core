import { describe, expect, it } from 'vitest';
import { MESH_VIEWER_META } from '../viewers/mesh/index.js';
import { CORE_VIEWER_DESCRIPTORS, MESH_VIEWER_DESCRIPTOR, detectViewer } from './index.js';
describe('mesh viewer detection', () => {
    it('routes all formats case-insensitively without requiring a host asset service', () => {
        for (const ext of ['glb', 'gltf', 'stl', 'obj']) {
            expect(detectViewer(`model.${ext}`).viewerId).toBe('mesh');
            expect(detectViewer(`MODEL.${ext.toUpperCase()}`, undefined, undefined, new Uint8Array([1])).viewerId).toBe('mesh');
        }
        const { inputOwnership: _, ...meta } = MESH_VIEWER_META;
        expect(MESH_VIEWER_DESCRIPTOR).toEqual(meta);
        expect(CORE_VIEWER_DESCRIPTORS.filter(d => d.id === 'mesh')).toHaveLength(1);
    });
    it('recognizes extensionless GLB, and respects adapter opt-out and other extensions', () => {
        const magic = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
        expect(detectViewer('model', undefined, undefined, magic)).toEqual({ viewerId: 'mesh', matchedBy: 'content' });
        expect(detectViewer('model', undefined, CORE_VIEWER_DESCRIPTORS.filter(d => d.id !== 'mesh'), magic).viewerId).toBe('fallback');
        expect(detectViewer('model.json').viewerId).toBe('json');
        expect(detectViewer('model.step').viewerId).toBe('stp');
    });
});
