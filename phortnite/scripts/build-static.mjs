// Copies the third-party libraries into public/vendor so the public/ folder can be hosted
// as plain static files (solo mode works anywhere; multiplayer needs `npm start`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public/vendor');
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};
copy(path.join(root, 'node_modules/three/build/three.module.js'), path.join(out, 'three.module.js'));
copy(path.join(root, 'node_modules/three/build/three.core.js'), path.join(out, 'three.core.js'));
copy(path.join(root, 'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs'), path.join(out, 'rapier.mjs'));
copy(path.join(root, 'node_modules/es-module-shims/dist/es-module-shims.js'), path.join(out, 'es-module-shims.js'));
copy(path.join(root, 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js'), path.join(out, 'addons/utils/BufferGeometryUtils.js'));
console.log('Copied libraries into public/vendor — public/ can now be served by any static web server.');
