// Merges many small static geometries into a few big meshes (one per material+chunk)
// while remembering which vertex range belongs to which object, so individual objects
// can be hidden (destroyed) and restored without extra draw calls.
import * as THREE from 'three';

export class Batch {
  constructor() {
    this.groups = new Map();  // key -> { mat, items: [{ id, geo }] }
    this.ranges = new Map();  // id -> [{ attr, start, count, orig }]
  }

  add(matKey, chunk, id, geo) {
    const key = `${matKey}|${chunk}`;
    let g = this.groups.get(key);
    if (!g) this.groups.set(key, (g = { mat: matKey, items: [] }));
    g.items.push({ id, geo });
  }

  build(materials, parent, { castShadow = true, receiveShadow = true } = {}) {
    const meshes = [];
    for (const g of this.groups.values()) {
      let vCount = 0, iCount = 0;
      for (const it of g.items) {
        vCount += it.geo.attributes.position.count;
        iCount += it.geo.index.count;
      }
      const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3);
      const uv = new Float32Array(vCount * 2), col = new Float32Array(vCount * 3);
      const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
      let v = 0, i = 0;
      const pending = [];
      for (const it of g.items) {
        const a = it.geo.attributes;
        const n = a.position.count;
        pos.set(a.position.array, v * 3);
        nor.set(a.normal.array, v * 3);
        uv.set(a.uv.array, v * 2);
        col.set(a.color.array, v * 3);
        const src = it.geo.index.array;
        for (let k = 0; k < src.length; k++) idx[i + k] = src[k] + v;
        pending.push({ id: it.id, start: v, count: n });
        v += n;
        i += src.length;
        it.geo.dispose();
      }
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(pos, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', posAttr);
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, materials[g.mat]);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      parent.add(mesh);
      meshes.push(mesh);
      for (const p of pending) {
        let list = this.ranges.get(p.id);
        if (!list) this.ranges.set(p.id, (list = []));
        list.push({ attr: posAttr, start: p.start, count: p.count, orig: pos.slice(p.start * 3, (p.start + p.count) * 3), hidden: false });
      }
    }
    this.groups.clear();
    return meshes;
  }

  setVisible(id, visible) {
    const list = this.ranges.get(id);
    if (!list) return;
    for (const r of list) {
      if (r.hidden === !visible) continue;
      r.hidden = !visible;
      const arr = r.attr.array;
      const o = r.start * 3;
      if (visible) {
        arr.set(r.orig, o);
      } else {
        const x = arr[o], y = arr[o + 1], z = arr[o + 2];
        for (let k = 0; k < r.count; k++) {
          arr[o + k * 3] = x; arr[o + k * 3 + 1] = y; arr[o + k * 3 + 2] = z;
        }
      }
      r.attr.addUpdateRange(o, r.count * 3);
      r.attr.needsUpdate = true;
    }
  }
}
