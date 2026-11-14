import type { ViewerDescriptor } from './index.js';
import { CFB_MAGIC } from '../parsers/cfb.js';

export const SARIF_VIEWER_DESCRIPTOR = {
    id: 'sarif', displayNameKey: 'sarif.title', extensions: ['sarif', 'sarif.json'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
export const GPS_VIEWER_DESCRIPTOR = {
    id: 'gps', displayNameKey: 'gps.title', extensions: ['gpx', 'kml', 'kmz'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
export const TRACE_VIEWER_DESCRIPTOR = {
    id: 'trace', displayNameKey: 'trace.title', extensions: ['trace.json', 'chrome-trace'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
export const SBOM_VIEWER_DESCRIPTOR = {
    id: 'sbom', displayNameKey: 'sbom.title', extensions: ['cdx.json', 'cyclonedx.json'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
export const MSG_VIEWER_DESCRIPTOR = {
    // ROS message definitions and Tcl msgcat catalogs also use .msg; claim only CFB files.
    id: 'msg', displayNameKey: 'msg.title', extensions: ['msg'], magicPrefix: CFB_MAGIC,
    priority: 20, requiredServices: [], optionalServices: ['save']
} satisfies ViewerDescriptor;
export const DRAWIO_VIEWER_DESCRIPTOR = {
    id: 'drawio', displayNameKey: 'drawio.title', extensions: ['drawio', 'dio'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
export const OPENDOCUMENT_VIEWER_DESCRIPTOR = {
    id: 'opendocument', displayNameKey: 'opendocument.title', extensions: ['odt', 'odp'],
    priority: 20, requiredServices: [], optionalServices: []
} satisfies ViewerDescriptor;
