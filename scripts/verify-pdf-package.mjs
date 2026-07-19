import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const required = [
    'dist/viewers/pdf/index.js',
    'dist/viewers/pdf/index.d.ts',
    'dist/viewers/pdf/self-loading.js',
    'dist/styles/pdf.css',
    'dist/assets/pdfjs/pdf.worker.min.mjs'
];

for (const file of required) {
    await access(path.join(root, file), constants.R_OK);
}
if (packageJson.exports?.['./assets/*'] !== './dist/assets/*') {
    throw new Error('package exports must expose ./assets/* from ./dist/assets/*');
}
if (!packageJson.exports?.['./viewers/pdf'] || !packageJson.exports?.['./viewers/pdf/self-loading']) {
    throw new Error('package exports are missing PDF viewer entries');
}
if (!packageJson.files?.includes('dist')) {
    throw new Error('package files must include dist');
}

console.log(`PDF package contract verified (${required.length} required files).`);
