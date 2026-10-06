// Weapon / item models built from primitives, cached per (key, rarity).
import * as THREE from 'three';
import { RARITY, AMMO } from '../../shared/constants.js';
import { paint, merge } from '../world/models.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const cache = new Map();
const DARK = 0x2a2e35, MID = 0x4b525c, LIGHT = 0x8a929c, WOOD = 0x8a5a32;

function box(w, h, d, x, y, z, color, rx = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return paint(g, color);
}
function cyl(r, len, x, y, z, color, seg = 8) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return paint(g, color);
}

const BUILDERS = {
  ar(acc) {
    return {
      parts: [
        box(0.075, 0.12, 0.46, 0, 0.02, 0.14, DARK),
        box(0.07, 0.085, 0.24, 0, 0.0, 0.47, acc),
        cyl(0.018, 0.22, 0, 0.02, 0.69, MID),
        box(0.06, 0.12, 0.24, 0, -0.01, -0.2, MID),
        box(0.05, 0.17, 0.08, 0, -0.12, 0.18, DARK, 0.25),
        box(0.04, 0.12, 0.05, 0, -0.09, 0.0, DARK, -0.25),
        box(0.03, 0.05, 0.12, 0, 0.11, 0.16, LIGHT),
        box(0.078, 0.03, 0.3, 0, 0.085, 0.16, acc),
      ],
      muzzle: [0, 0.02, 0.8],
    };
  },
  // boxy rifle with a red-dot, skeleton stock and muzzle brake: reads apart from the AR at a glance
  burst(acc) {
    return {
      parts: [
        box(0.08, 0.13, 0.4, 0, 0.02, 0.1, MID),
        box(0.05, 0.025, 0.42, 0, 0.1, 0.14, acc),
        box(0.075, 0.09, 0.26, 0, 0.0, 0.42, DARK),
        box(0.079, 0.045, 0.24, 0, -0.005, 0.42, acc),
        cyl(0.017, 0.16, 0, 0.02, 0.63, MID),
        box(0.045, 0.045, 0.07, 0, 0.02, 0.73, DARK),
        box(0.05, 0.15, 0.07, 0, -0.11, 0.2, DARK, 0.1),
        box(0.04, 0.12, 0.05, 0, -0.09, 0.0, DARK, -0.25),
        box(0.05, 0.03, 0.22, 0, 0.05, -0.2, DARK),
        box(0.05, 0.03, 0.22, 0, -0.04, -0.2, DARK),
        box(0.06, 0.13, 0.04, 0, 0.005, -0.31, acc),
        box(0.04, 0.05, 0.07, 0, 0.14, 0.1, DARK),
        box(0.03, 0.03, 0.01, 0, 0.145, 0.135, acc),
      ],
      muzzle: [0, 0.02, 0.77],
    };
  },
  smg(acc) {
    return {
      parts: [
        box(0.07, 0.11, 0.34, 0, 0.02, 0.12, DARK),
        box(0.068, 0.07, 0.14, 0, 0.0, 0.34, acc),
        cyl(0.017, 0.12, 0, 0.02, 0.46, MID),
        box(0.045, 0.22, 0.06, 0, -0.15, 0.12, DARK),
        box(0.04, 0.12, 0.05, 0, -0.09, -0.02, DARK, -0.25),
        box(0.03, 0.04, 0.1, 0, 0.1, 0.1, acc),
        box(0.03, 0.03, 0.18, 0, 0.0, -0.12, LIGHT),
      ],
      muzzle: [0, 0.02, 0.53],
    };
  },
  shotgun(acc) {
    return {
      parts: [
        box(0.07, 0.11, 0.3, 0, 0.02, 0.06, DARK),
        cyl(0.025, 0.62, 0, 0.045, 0.5, MID),
        cyl(0.022, 0.4, 0, -0.01, 0.42, DARK),
        box(0.075, 0.07, 0.17, 0, -0.01, 0.4, WOOD),
        box(0.065, 0.13, 0.28, 0, -0.03, -0.22, WOOD, -0.12),
        box(0.04, 0.11, 0.05, 0, -0.08, -0.03, DARK, -0.3),
        box(0.074, 0.025, 0.2, 0, 0.083, 0.05, acc),
      ],
      muzzle: [0, 0.045, 0.82],
    };
  },
  // black polymer semi-auto: heat shield over the barrel, pistol grip, folding top stock (no wood)
  tactical(acc) {
    return {
      parts: [
        box(0.075, 0.12, 0.32, 0, 0.02, 0.04, DARK),
        box(0.077, 0.025, 0.2, 0, 0.083, 0.03, acc),
        cyl(0.024, 0.5, 0, 0.05, 0.45, MID),
        box(0.06, 0.035, 0.42, 0, 0.082, 0.43, LIGHT),
        cyl(0.02, 0.44, 0, -0.01, 0.4, DARK),
        box(0.08, 0.075, 0.18, 0, -0.01, 0.34, DARK),
        box(0.082, 0.02, 0.1, 0, -0.01, 0.34, acc),
        box(0.045, 0.13, 0.055, 0, -0.1, -0.04, DARK, -0.3),
        box(0.03, 0.03, 0.3, 0, 0.09, -0.24, MID),
        box(0.05, 0.12, 0.04, 0, 0.04, -0.38, DARK),
      ],
      muzzle: [0, 0.05, 0.71],
    };
  },
  sniper(acc) {
    return {
      parts: [
        box(0.075, 0.11, 0.4, 0, 0.02, 0.1, DARK),
        cyl(0.02, 0.62, 0, 0.03, 0.6, MID),
        cyl(0.03, 0.08, 0, 0.03, 0.94, DARK),
        cyl(0.038, 0.3, 0, 0.13, 0.12, DARK, 10),
        cyl(0.044, 0.04, 0, 0.13, 0.27, acc, 10),
        cyl(0.044, 0.04, 0, 0.13, -0.03, acc, 10),
        box(0.065, 0.13, 0.3, 0, -0.02, -0.24, acc),
        box(0.04, 0.12, 0.05, 0, -0.09, -0.02, DARK, -0.25),
        box(0.04, 0.08, 0.06, 0, -0.08, 0.16, DARK),
      ],
      muzzle: [0, 0.03, 0.99],
    };
  },
  pistol(acc) {
    return {
      parts: [
        box(0.045, 0.07, 0.24, 0, 0.04, 0.08, DARK),
        box(0.042, 0.03, 0.2, 0, 0.085, 0.09, acc),
        box(0.04, 0.13, 0.06, 0, -0.04, 0.0, MID, -0.2),
      ],
      muzzle: [0, 0.045, 0.21],
    };
  },
  rocket(acc) {
    const tube = new THREE.CylinderGeometry(0.085, 0.085, 1.05, 12, 1, true);
    tube.rotateX(Math.PI / 2);
    tube.translate(0, 0.07, 0.12);
    paint(tube, 0x3d5a3a);
    const cone = new THREE.ConeGeometry(0.07, 0.2, 10);
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0.07, 0.72);
    paint(cone, acc);
    return {
      parts: [
        tube, cone,
        cyl(0.095, 0.08, 0, 0.07, -0.38, DARK, 12),
        cyl(0.095, 0.06, 0, 0.07, 0.62, DARK, 12),
        box(0.04, 0.13, 0.06, 0, -0.04, 0.05, DARK, -0.2),
        box(0.04, 0.12, 0.05, 0, -0.04, 0.3, DARK),
        box(0.05, 0.06, 0.14, 0.07, 0.16, 0.18, LIGHT),
      ],
      muzzle: [0, 0.07, 0.7],
    };
  },
  pickaxe() {
    const head1 = new THREE.BoxGeometry(0.06, 0.07, 0.34);
    head1.rotateX(0.35);
    head1.translate(0, 0.66, 0.16);
    const head2 = new THREE.BoxGeometry(0.05, 0.06, 0.22);
    head2.rotateX(-0.35);
    head2.translate(0, 0.66, -0.12);
    return {
      parts: [
        paint(new THREE.CylinderGeometry(0.022, 0.026, 0.78, 6).translate(0, 0.32, 0), 0x6b4a2c),
        box(0.08, 0.1, 0.1, 0, 0.66, 0, 0x2a5dd6),
        paint(head1, 0xdfe6f0),
        paint(head2, 0xdfe6f0),
        box(0.05, 0.12, 0.05, 0, 0.0, 0, 0x2a5dd6),
      ],
      muzzle: [0, 0.66, 0.3],
    };
  },
  bandage() {
    return { parts: [paint(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10).rotateZ(Math.PI / 2), 0xf3efe6), box(0.02, 0.13, 0.13, 0.06, 0, 0, 0xd8d0c0)], muzzle: [0, 0, 0] };
  },
  medkit() {
    return { parts: [box(0.26, 0.18, 0.14, 0, 0, 0, 0xf3f3f3), box(0.12, 0.035, 0.145, 0, 0, 0, 0xe23a3a), box(0.035, 0.12, 0.145, 0, 0, 0, 0xe23a3a), box(0.08, 0.03, 0.03, 0, 0.1, 0, 0x777777)], muzzle: [0, 0, 0] };
  },
  shield_s() {
    const b = paint(new THREE.SphereGeometry(0.06, 10, 8), 0x3ec8ff);
    return { parts: [b, cyl(0.02, 0.06, 0, 0.07, 0, 0xffffff).rotateX(Math.PI / 2).translate(0, 0, 0)], muzzle: [0, 0, 0] };
  },
  shield_b() {
    const b = paint(new THREE.CylinderGeometry(0.07, 0.085, 0.2, 12), 0x2f8dff);
    const neck = paint(new THREE.CylinderGeometry(0.025, 0.035, 0.07, 8).translate(0, 0.13, 0), 0xdfe9ff);
    const cap = paint(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 8).translate(0, 0.18, 0), 0x2a5dd6);
    return { parts: [b, neck, cap], muzzle: [0, 0, 0] };
  },
  ammo(color) {
    return { parts: [box(0.26, 0.14, 0.18, 0, 0, 0, 0x4a4f3a), box(0.27, 0.04, 0.19, 0, 0.03, 0, color), box(0.06, 0.03, 0.03, 0, 0.085, 0, 0x2b2b2b)], muzzle: [0, 0, 0] };
  },
  wood() {
    return { parts: [box(0.5, 0.06, 0.16, 0, 0, 0, 0xc08048), box(0.5, 0.06, 0.16, 0.03, 0.07, 0.04, 0xa86c3a), box(0.5, 0.06, 0.16, -0.02, 0.14, -0.02, 0xc8884f)], muzzle: [0, 0, 0] };
  },
  stone() {
    return { parts: [box(0.22, 0.1, 0.12, -0.12, 0, 0, 0xb5553a), box(0.22, 0.1, 0.12, 0.12, 0, 0, 0xa64a32), box(0.22, 0.1, 0.12, 0, 0.11, 0, 0xc0603f)], muzzle: [0, 0, 0] };
  },
  metal() {
    return { parts: [box(0.42, 0.04, 0.3, 0, 0, 0, 0x9aa8b5), box(0.42, 0.04, 0.3, 0.02, 0.05, 0.02, 0x7d8a96)], muzzle: [0, 0, 0] };
  },
};

/** Returns { geo, muzzle: Vector3 } for an item key. */
export function itemModel(key, rarity = 0) {
  const ck = `${key}|${rarity}`;
  let m = cache.get(ck);
  if (m) return m;
  const acc = new THREE.Color(RARITY[rarity] ? RARITY[rarity].color : '#ffffff').getHex();
  let built;
  if (hasOwn(AMMO, key)) built = BUILDERS.ammo(new THREE.Color(AMMO[key].color).getHex());
  else if (hasOwn(BUILDERS, key) && key !== 'ammo') built = BUILDERS[key](acc);
  else built = BUILDERS.ammo(0xffffff);
  m = { geo: merge(built.parts), muzzle: new THREE.Vector3(...built.muzzle) };
  cache.set(ck, m);
  return m;
}

let sharedMat = null;
export function itemMaterial() {
  if (!sharedMat) sharedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.35 });
  return sharedMat;
}
