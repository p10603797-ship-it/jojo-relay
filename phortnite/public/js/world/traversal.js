// Launch pads, geysers and bounce mushrooms (data.pads): instanced models, a little glow, and the
// lookup MapClient uses to throw people into the air (js/ui/mapclient.js does the launching,
// because it knows who is simulated on this device).
import * as THREE from 'three';
import * as M from './models.js';

/** Launch speeds per kind: up (m/s) and along the way you face (m/s). */
export const PAD_KICK = {
  launch: { up: 45, fwd: 10, glide: true },
  geyser: { up: 38, fwd: 2, glide: true },
  mushroom: { up: 24, fwd: 4, glide: false },
};

/** A simple stand-in model when models.js has none for the kind. */
function fallbackGeometry(kind) {
  const paint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    if (g.index === null) g = g.toNonIndexed();
    return g;
  };
  const merge = (list) => {
    const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) {
      g.computeVertexNormals();
      pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
      o += g.attributes.position.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return out;
  };
  const cyl = (rt, rb, h, y, hex, seg = 16) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(0, y + h / 2, 0); return paint(g, hex); };
  if (kind === 'geyser') {
    return merge([cyl(1.5, 1.8, 0.35, 0, 0x6a625a, 10), cyl(0.9, 0.9, 0.38, 0, 0xeaf6ff, 12)]);
  }
  if (kind === 'mushroom') {
    const cap = new THREE.SphereGeometry(1.7, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.6, 1);
    cap.translate(0, 1.3, 0);
    return merge([cyl(0.35, 0.5, 1.4, 0, 0xf2ead8, 8), paint(cap, 0xe83a6a)]);
  }
  const arrow = new THREE.ConeGeometry(0.7, 0.9, 3);
  arrow.rotateX(-Math.PI / 2);
  arrow.translate(0, 0.42, 0);
  return merge([cyl(1.5, 1.6, 0.25, 0, 0x2f6fd8, 20), cyl(1.1, 1.1, 0.28, 0, 0x6fe0ff, 20), paint(arrow, 0xffd23f)]);
}

export class Traversal {
  constructor(world) {
    this.world = world;
    const d = world.data;
    this.pads = (d.pads || []).filter((p) => PAD_KICK[p.kind]).map((p) => ({
      ...p,
      y: p.y ?? d.heightAt(p.x, p.z),
      // a mushroom throws you when you walk onto its cap (about 1.3 m up)
      top: p.kind === 'mushroom' ? 1.3 : 0.3,
    }));
    this.meshes = [];
    this.time = 0;
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1, emissive: 0x1a2a40, emissiveIntensity: 1 });
    const byKind = new Map();
    for (const p of this.pads) {
      if (!byKind.has(p.kind)) byKind.set(p.kind, []);
      byKind.get(p.kind).push(p);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const [kind, list] of byKind) {
      let geo = null;
      try { geo = M.propGeometry ? M.propGeometry(kind, 0) : null; } catch (e) { geo = null; }
      if (!geo || !geo.attributes.position.count) geo = fallbackGeometry(kind);
      const mesh = new THREE.InstancedMesh(geo, this.mat, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, ((p.id || i) * 2.399) % (Math.PI * 2));
        s.setScalar(p.kind === 'mushroom' ? 1 + ((p.power || 1) - 1) * 0.3 : 1);
        m4.compose(v.set(p.x, p.y, p.z), q, s);
        mesh.setMatrixAt(i, m4);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `pads-${kind}`;
      world.root.add(mesh);
      this.meshes.push(mesh);
    }
  }

  /** The pad under a point (feet position), or null. */
  padAt(x, y, z, r = 1.6) {
    for (const p of this.pads) {
      const dx = p.x - x, dz = p.z - z;
      const R = p.kind === 'mushroom' ? 1.9 : r;
      if (dx * dx + dz * dz > R * R) continue;
      const dy = y - (p.y + p.top);
      if (dy > -0.9 && dy < 1.6) return p;
    }
    return null;
  }

  update(dt) {
    this.time += dt;
    if (this.meshes.length) this.mat.emissiveIntensity = 0.8 + 0.6 * Math.sin(this.time * 3);
  }
}
