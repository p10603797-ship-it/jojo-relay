// Stylised humanoid: one skinned mesh per character (single draw call), procedural
// animation, weapon attachment, glider, name tag and a Rapier-driven ragdoll on death.
import * as THREE from 'three';
import { SKINS, ANIM, WEAPONS } from '../../shared/constants.js';
import { itemModel, itemMaterial } from '../combat/weaponModels.js';
import { gliderGeometry } from '../world/models.js';
import { GROUP } from '../physics.js';

const BONES = [
  ['root', -1, [0, 0, 0]],
  ['hips', 0, [0, 0.95, 0]],
  ['spine', 1, [0, 1.1, 0]],
  ['head', 2, [0, 1.5, 0]],
  ['armL', 2, [0.25, 1.43, 0]],
  ['foreL', 4, [0.27, 1.17, 0]],
  ['armR', 2, [-0.25, 1.43, 0]],
  ['foreR', 6, [-0.27, 1.17, 0]],
  ['thighL', 1, [0.11, 0.9, 0]],
  ['shinL', 8, [0.11, 0.5, 0]],
  ['thighR', 1, [-0.11, 0.9, 0]],
  ['shinR', 10, [-0.11, 0.5, 0]],
];
const B = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

const geoCache = new Map();
const gliderCache = new Map();
let charMat = null;

function part(geo, bone, color) {
  const n = geo.attributes.position.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo.index ? geo.toNonIndexed() : geo;
}

function capsule(r, len, x, y, z) {
  const g = new THREE.CapsuleGeometry(r, len, 4, 10);
  g.translate(x, y, z);
  return g;
}

function buildGeometry(skin) {
  const s = SKINS[skin] || SKINS[0];
  const P = [];
  // torso & pelvis
  const torso = new THREE.CylinderGeometry(0.215, 0.175, 0.5, 12, 2);
  torso.scale(1, 1, 0.66);
  torso.translate(0, 1.27, 0);
  P.push(part(torso, B.spine, s.outfit));
  const chestStripe = new THREE.CylinderGeometry(0.218, 0.2, 0.08, 12);
  chestStripe.scale(1, 1, 0.67);
  chestStripe.translate(0, 1.36, 0);
  P.push(part(chestStripe, B.spine, s.accent));
  const shoulders = new THREE.SphereGeometry(0.2, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  shoulders.scale(1.15, 0.45, 0.72);
  shoulders.translate(0, 1.5, 0);
  P.push(part(shoulders, B.spine, s.outfit));
  const pelvis = new THREE.CylinderGeometry(0.18, 0.16, 0.2, 12);
  pelvis.scale(1, 1, 0.7);
  pelvis.translate(0, 0.98, 0);
  P.push(part(pelvis, B.hips, s.pants));
  const belt = new THREE.CylinderGeometry(0.185, 0.185, 0.05, 12);
  belt.scale(1, 1, 0.71);
  belt.translate(0, 1.07, 0);
  P.push(part(belt, B.hips, 0x2a2420));
  const pack = new THREE.BoxGeometry(0.3, 0.34, 0.13);
  pack.translate(0, 1.28, -0.19);
  P.push(part(pack, B.spine, s.accent));
  const packFlap = new THREE.BoxGeometry(0.31, 0.1, 0.14);
  packFlap.translate(0, 1.42, -0.19);
  P.push(part(packFlap, B.spine, s.outfit));
  // head
  const neck = new THREE.CylinderGeometry(0.06, 0.07, 0.12, 8);
  neck.translate(0, 1.54, 0);
  P.push(part(neck, B.head, s.skin));
  const head = new THREE.SphereGeometry(0.155, 16, 12);
  head.scale(1, 1.08, 1);
  head.translate(0, 1.7, 0.01);
  P.push(part(head, B.head, s.skin));
  const hair = new THREE.SphereGeometry(0.168, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
  hair.scale(1.02, 1.08, 1.04);
  hair.translate(0, 1.715, -0.012);
  P.push(part(hair, B.head, s.hair));
  for (const x of [0.058, -0.058]) {
    const eyeW = new THREE.SphereGeometry(0.032, 8, 6);
    eyeW.scale(1, 1.15, 0.5);
    eyeW.translate(x, 1.71, 0.142);
    P.push(part(eyeW, B.head, 0xffffff));
    const eye = new THREE.SphereGeometry(0.019, 8, 6);
    eye.translate(x, 1.708, 0.156);
    P.push(part(eye, B.head, 0x1a1a1a));
    const brow = new THREE.BoxGeometry(0.06, 0.012, 0.02);
    brow.translate(x, 1.76, 0.147);
    P.push(part(brow, B.head, s.hair));
  }
  const mouth = new THREE.BoxGeometry(0.06, 0.012, 0.02);
  mouth.translate(0, 1.632, 0.146);
  P.push(part(mouth, B.head, 0x6b2a20));
  // arms
  for (const [arm, fore, x] of [[B.armL, B.foreL, 0.255], [B.armR, B.foreR, -0.255]]) {
    const sh = new THREE.SphereGeometry(0.085, 10, 8);
    sh.translate(x, 1.43, 0);
    P.push(part(sh, arm, s.outfit));
    P.push(part(capsule(0.066, 0.18, x, 1.3, 0), arm, s.outfit));
    P.push(part(capsule(0.058, 0.16, x * 1.05, 1.06, 0), fore, s.skin));
    const glove = new THREE.SphereGeometry(0.068, 10, 8);
    glove.scale(1, 1.15, 0.9);
    glove.translate(x * 1.06, 0.9, 0);
    P.push(part(glove, fore, s.accent));
  }
  // legs
  for (const [thigh, shin, x] of [[B.thighL, B.shinL, 0.105], [B.thighR, B.shinR, -0.105]]) {
    P.push(part(capsule(0.088, 0.26, x, 0.71, 0), thigh, s.pants));
    P.push(part(capsule(0.076, 0.26, x, 0.3, 0), shin, s.pants));
    const shoe = new THREE.BoxGeometry(0.13, 0.1, 0.25);
    shoe.translate(x, 0.05, 0.04);
    P.push(part(shoe, shin, s.shoes));
    const sole = new THREE.BoxGeometry(0.135, 0.03, 0.26);
    sole.translate(x, 0.005, 0.04);
    P.push(part(sole, shin, 0x222222));
  }
  // merge (non-indexed)
  let total = 0;
  for (const g of P) total += g.attributes.position.count;
  const geo = new THREE.BufferGeometry();
  const attrs = { position: 3, normal: 3, color: 3, skinIndex: 4, skinWeight: 4 };
  for (const [name, size] of Object.entries(attrs)) {
    const Arr = name === 'skinIndex' ? Uint16Array : Float32Array;
    const arr = new Arr(total * size);
    let o = 0;
    for (const g of P) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    geo.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  geo.computeBoundingSphere();
  return geo;
}

function getGeometry(skin) {
  let g = geoCache.get(skin);
  if (!g) geoCache.set(skin, (g = buildGeometry(skin)));
  return g;
}

function nameTag(text, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const g = c.getContext('2d');
  g.font = 'bold 28px "Luckiest Guy", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.strokeText(text, 128, 26);
  g.fillStyle = color;
  g.fillText(text, 128, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true }));
  sp.scale.set(1.6, 0.3, 1);
  sp.position.y = 2.2;
  return sp;
}

const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

export class Character {
  constructor(skin = 0, name = '', opts = {}) {
    this.skin = skin;
    if (!charMat) charMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
    this.group = new THREE.Group();
    this.model = new THREE.Group();
    this.group.add(this.model);
    const geo = getGeometry(skin);
    const bones = BONES.map(([n]) => { const b = new THREE.Bone(); b.name = n; return b; });
    BONES.forEach(([, parent, p], i) => {
      if (parent < 0) bones[i].position.set(...p);
      else {
        const pp = BONES[parent][2];
        bones[i].position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
        bones[parent].add(bones[i]);
      }
    });
    this.mesh = new THREE.SkinnedMesh(geo, charMat);
    this.mesh.add(bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.model.add(this.mesh);
    this.bones = Object.fromEntries(BONES.map(([n], i) => [n, bones[i]]));
    this.rest = bones.map((b) => b.position.clone());

    // weapon holders: guns live on the chest, melee/items in the right hand
    this.gunHolder = new THREE.Group();
    this.gunHolder.position.set(-0.15, 0.24, 0.26);
    this.bones.spine.add(this.gunHolder);
    this.handHolder = new THREE.Group();
    this.handHolder.position.set(-0.01, -0.28, 0.02);
    this.bones.foreR.add(this.handHolder);
    this.weaponMesh = null;
    this.weaponKey = null;
    this.muzzle = new THREE.Object3D();

    const sk = SKINS[skin] || SKINS[0];
    let gg = gliderCache.get(skin);
    if (!gg) gliderCache.set(skin, (gg = gliderGeometry(sk.outfit, sk.accent)));
    this.glider = new THREE.Mesh(gg, itemMaterial());
    this.glider.position.set(0, 2.55, 0);
    this.glider.visible = false;
    this.glider.castShadow = true;
    this.group.add(this.glider);

    this.tag = null;
    if (name) this.setName(name, opts.tagColor);

    this.phase = 0;
    this.time = Math.random() * 10;
    this.swing = 0;
    this.recoil = 0;
    this.lean = 0;
    this.crouchK = 0;
    this.airK = 0;
    this.ragdoll = null;
    this.dissolve = 0;
    this.visible = true;
  }

  setName(name, color) {
    if (this.tag) { this.group.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); }
    this.tag = nameTag(name, color);
    this.group.add(this.tag);
  }

  setWeapon(key, rarity = 0) {
    const k = `${key}|${rarity}`;
    if (this.weaponKey === k) return;
    this.weaponKey = k;
    if (this.weaponMesh) this.weaponMesh.parent.remove(this.weaponMesh);
    this.weaponMesh = null;
    if (!key) return;
    const m = itemModel(key, rarity);
    const mesh = new THREE.Mesh(m.geo, itemMaterial());
    mesh.castShadow = true;
    mesh.scale.setScalar(WEAPONS[key] ? 1.3 : 1.15);
    if (key === 'pickaxe') {
      mesh.rotation.set(Math.PI / 2 + 0.2, 0, 0);
      this.handHolder.add(mesh);
    } else if (WEAPONS[key]) {
      if (key === 'rocket') mesh.position.set(-0.04, 0.12, -0.08);
      if (key === 'pistol') mesh.position.set(0.02, 0.0, 0.12);
      this.gunHolder.add(mesh);
    } else {
      mesh.rotation.set(Math.PI / 2, 0, 0);
      this.handHolder.add(mesh);
    }
    this.weaponMesh = mesh;
    this.muzzle.position.copy(m.muzzle);
    this.muzzle.position.z += 0.02;
    mesh.add(this.muzzle);
  }

  /** World position of the weapon muzzle (falls back to the chest). */
  muzzleWorld(out) {
    if (this.weaponMesh) return this.muzzle.getWorldPosition(out);
    return this.bones.spine.getWorldPosition(out).add(_v1.set(0, 0.35, 0));
  }

  headWorld(out) { return this.bones.head.getWorldPosition(out).add(_v1.set(0, 0.2, 0)); }

  playSwing() { this.swing = 1; }
  kick(amount) { this.recoil = Math.min(1, this.recoil + amount); }

  /**
   * s = { anim, speed, moveAngle, pitch, ads, gun, building, healing, reload (0..1 or -1), dt }
   */
  update(dt, s) {
    if (this.ragdoll) { this.updateRagdoll(dt); return; }
    const b = this.bones;
    this.time += dt;
    const anim = s.anim;
    const speed = s.speed || 0;
    const crouch = anim === ANIM.CROUCH || anim === ANIM.CROUCH_WALK;
    const air = anim === ANIM.AIR;
    this.crouchK += ((crouch ? 1 : 0) - this.crouchK) * Math.min(1, dt * 12);
    this.airK += ((air ? 1 : 0) - this.airK) * Math.min(1, dt * 10);
    this.swing = Math.max(0, this.swing - dt * 3.2);
    this.recoil = Math.max(0, this.recoil - dt * 9);

    // reset pose
    for (let i = 1; i < BONES.length; i++) {
      const bone = this.mesh.skeleton.bones[i];
      bone.position.copy(this.rest[i]);
      bone.rotation.set(0, 0, 0);
    }
    this.model.rotation.set(0, 0, 0);
    this.model.position.set(0, 0, 0);
    this.glider.visible = anim === ANIM.GLIDE;

    if (anim === ANIM.SKYDIVE) {
      const t = this.time;
      this.model.rotation.x = 1.25;
      this.model.position.y = 0.9;
      b.armL.rotation.z = 1.25 + Math.sin(t * 6) * 0.08;
      b.armR.rotation.z = -1.25 - Math.sin(t * 6 + 1) * 0.08;
      b.armL.rotation.x = -0.3; b.armR.rotation.x = -0.3;
      b.foreL.rotation.x = -0.5; b.foreR.rotation.x = -0.5;
      b.thighL.rotation.z = 0.28; b.thighR.rotation.z = -0.28;
      b.thighL.rotation.x = 0.25; b.thighR.rotation.x = 0.25;
      b.shinL.rotation.x = 0.6 + Math.sin(t * 5) * 0.1; b.shinR.rotation.x = 0.6 + Math.cos(t * 5) * 0.1;
      b.head.rotation.x = -0.9;
      this.showWeapon(false);
      return;
    }
    if (anim === ANIM.GLIDE) {
      b.armL.rotation.z = 2.75; b.armR.rotation.z = -2.75;
      b.foreL.rotation.x = -0.3; b.foreR.rotation.x = -0.3;
      b.thighL.rotation.x = -0.25; b.thighR.rotation.x = 0.1;
      b.shinL.rotation.x = 0.4; b.shinR.rotation.x = 0.25;
      this.model.rotation.x = 0.12;
      this.showWeapon(false);
      return;
    }
    if (anim === ANIM.DANCE) {
      // the floss
      const t = this.time * 7.5;
      const sw = Math.sin(t);
      const front = Math.cos(t) > 0 ? 1 : -1;
      b.hips.rotation.z = sw * 0.18;
      b.hips.position.x = -sw * 0.08;
      b.spine.rotation.z = -sw * 0.3;
      b.armL.rotation.z = 0.35 + sw * 0.55;
      b.armR.rotation.z = -0.35 + sw * 0.55;
      b.armL.rotation.x = front * 0.45;
      b.armR.rotation.x = -front * 0.45;
      b.thighL.rotation.x = -0.12 + Math.abs(sw) * 0.15;
      b.thighR.rotation.x = -0.12 + Math.abs(sw) * 0.15;
      b.shinL.rotation.x = 0.25; b.shinR.rotation.x = 0.25;
      b.head.rotation.z = sw * 0.15;
      this.showWeapon(false);
      return;
    }
    this.showWeapon(!s.building);

    // locomotion
    const moving = speed > 0.4;
    const back = Math.abs(s.moveAngle || 0) > 1.9;
    const runK = Math.min(1, speed / 6.5);
    this.phase += dt * (3 + speed * 1.45) * (back ? -1 : 1) * (moving ? 1 : 0);
    const ph = this.phase;
    let ma = s.moveAngle || 0;
    if (back) ma = ma > 0 ? ma - Math.PI : ma + Math.PI;
    const hipYaw = moving ? Math.max(-0.75, Math.min(0.75, ma)) : 0;
    b.hips.rotation.y = hipYaw;
    b.spine.rotation.y = -hipYaw;
    const amp = moving ? 0.35 + runK * 0.55 : 0;
    const lean = moving ? runK * 0.12 : 0;
    b.thighL.rotation.x = -Math.sin(ph) * amp;
    b.thighR.rotation.x = Math.sin(ph) * amp;
    b.shinL.rotation.x = moving ? (0.15 + Math.max(0, Math.cos(ph)) * 1.1 * amp) : 0.05;
    b.shinR.rotation.x = moving ? (0.15 + Math.max(0, -Math.cos(ph)) * 1.1 * amp) : 0.05;
    b.hips.position.y += moving ? -Math.abs(Math.sin(ph)) * 0.035 * runK : Math.sin(this.time * 2) * 0.006;
    b.spine.rotation.x = lean;

    // crouch
    const ck = this.crouchK;
    if (ck > 0.01) {
      b.hips.position.y -= 0.32 * ck;
      b.thighL.rotation.x += -1.0 * ck; b.thighR.rotation.x += -1.0 * ck;
      b.shinL.rotation.x += 1.35 * ck; b.shinR.rotation.x += 1.35 * ck;
      b.spine.rotation.x += 0.22 * ck;
    }
    // airborne
    const ak = this.airK;
    if (ak > 0.01) {
      b.thighL.rotation.x = b.thighL.rotation.x * (1 - ak) - 0.6 * ak;
      b.thighR.rotation.x = b.thighR.rotation.x * (1 - ak) + 0.15 * ak;
      b.shinL.rotation.x = b.shinL.rotation.x * (1 - ak) + 0.9 * ak;
      b.shinR.rotation.x = b.shinR.rotation.x * (1 - ak) + 0.5 * ak;
    }

    const pitch = s.pitch || 0;
    b.head.rotation.x = -pitch * 0.35;
    const gun = s.gun;
    if (gun && !s.building && !s.healing) {
      // two handed aim pose; whole upper body follows the aim pitch
      b.spine.rotation.x += -pitch * 0.62 - this.recoil * 0.12;
      b.armR.rotation.x = -1.25 - pitch * 0.15;
      b.armR.rotation.z = 0.15;
      b.foreR.rotation.x = -0.55;
      b.armL.rotation.x = -1.45 - pitch * 0.15;
      b.armL.rotation.z = -0.62;
      b.armL.rotation.y = 0.2;
      b.foreL.rotation.x = -0.35;
      if (s.ads) { b.head.rotation.y = 0.15; b.head.rotation.x -= 0.1; }
      if (s.reload >= 0) {
        const r = Math.sin(s.reload * Math.PI);
        b.armL.rotation.x += r * 0.7;
        b.foreL.rotation.x -= r * 0.6;
        this.gunHolder.rotation.z = r * 0.5;
      } else this.gunHolder.rotation.z = 0;
      this.gunHolder.position.z = 0.26 - this.recoil * 0.08;
    } else if (s.building) {
      b.armR.rotation.x = -0.9; b.foreR.rotation.x = -0.8;
      b.armL.rotation.x = -0.9; b.foreL.rotation.x = -0.8;
      b.armL.rotation.z = -0.2; b.armR.rotation.z = 0.2;
    } else if (s.healing) {
      b.armR.rotation.x = -0.8 + Math.sin(this.time * 9) * 0.1; b.foreR.rotation.x = -1.3;
      b.armL.rotation.x = -0.8; b.foreL.rotation.x = -1.2;
      b.armL.rotation.z = -0.3; b.armR.rotation.z = 0.3;
    } else {
      // pickaxe / empty hands: arm swing + harvest swing
      const sw = moving ? Math.sin(ph) * 0.6 * amp : 0;
      b.armL.rotation.x = sw;
      b.armR.rotation.x = -sw - 0.25;
      b.foreL.rotation.x = -0.25; b.foreR.rotation.x = -0.6;
      b.armL.rotation.z = 0.1; b.armR.rotation.z = -0.1;
      if (this.swing > 0) {
        const t = 1 - this.swing;
        const a = t < 0.35 ? -2.6 * (t / 0.35) : -2.6 + 2.9 * Math.min(1, (t - 0.35) / 0.3);
        b.armR.rotation.x = a;
        b.foreR.rotation.x = -0.4;
        b.spine.rotation.x += t < 0.35 ? -0.15 : 0.2;
        b.spine.rotation.y += 0.25;
      }
    }
  }

  showWeapon(v) { if (this.weaponMesh) this.weaponMesh.visible = v; }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  // ------------------------------------------------------------------ ragdoll
  startRagdoll(physics, impulse) {
    if (this.ragdoll) return;
    const R = physics.R;
    const world = physics.world;
    this.group.updateMatrixWorld(true);
    this.glider.visible = false;
    if (this.tag) this.tag.visible = false;
    const segs = [
      // masses in kg; keeping the ratios modest keeps the joints stable
      { bone: 'hips', shape: () => R.ColliderDesc.capsule(0.22, 0.17).setTranslation(0, 0.3, 0), mass: 14 },
      { bone: 'head', shape: () => R.ColliderDesc.ball(0.15).setTranslation(0, 0.2, 0), mass: 4 },
      { bone: 'armL', shape: () => R.ColliderDesc.capsule(0.2, 0.06).setTranslation(0, -0.25, 0), mass: 3 },
      { bone: 'armR', shape: () => R.ColliderDesc.capsule(0.2, 0.06).setTranslation(0, -0.25, 0), mass: 3 },
      { bone: 'thighL', shape: () => R.ColliderDesc.capsule(0.3, 0.08).setTranslation(0, -0.4, 0), mass: 6 },
      { bone: 'thighR', shape: () => R.ColliderDesc.capsule(0.3, 0.08).setTranslation(0, -0.4, 0), mass: 6 },
    ];
    const bodies = {};
    for (const s of segs) {
      const bone = this.bones[s.bone];
      bone.matrixWorld.decompose(_v1, _q1, _v2);
      const body = world.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(_v1.x, _v1.y, _v1.z)
        .setRotation({ x: _q1.x, y: _q1.y, z: _q1.z, w: _q1.w })
        .setLinearDamping(0.4).setAngularDamping(1.5).setCcdEnabled(true));
      physics.collider(s.shape().setMass(s.mass).setFriction(0.9), null, body, GROUP.RAGDOLL, GROUP.WORLD | GROUP.BUILD | GROUP.PROP);
      const iv = impulse || { x: 0, y: 0, z: 0 };
      body.setLinvel({ x: iv.x, y: iv.y + 1.5, z: iv.z }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
      bodies[s.bone] = body;
    }
    const joint = (parent, child) => {
      const pb = bodies[parent], cb = bodies[child];
      // anchor = child bone origin expressed in the parent body frame
      const ct = cb.translation(), pt = pb.translation(), pr = pb.rotation();
      _q1.set(pr.x, pr.y, pr.z, pr.w).invert();
      _v1.set(ct.x - pt.x, ct.y - pt.y, ct.z - pt.z).applyQuaternion(_q1);
      const params = R.JointData.spherical({ x: _v1.x, y: _v1.y, z: _v1.z }, { x: 0, y: 0, z: 0 });
      const j = world.createImpulseJoint(params, pb, cb, true);
      j.setContactsEnabled(false);
    };
    joint('hips', 'head');
    joint('hips', 'armL');
    joint('hips', 'armR');
    joint('hips', 'thighL');
    joint('hips', 'thighR');
    this.ragdoll = { physics, bodies, t: 0 };
    // straighten the secondary bones so the limbs read as rigid segments
    this.bones.spine.rotation.set(0, 0, 0);
    this.bones.spine.position.copy(this.rest[B.spine]);
  }

  updateRagdoll(dt) {
    const rd = this.ragdoll;
    rd.t += dt;
    // group/model act as the frame of reference
    this.model.updateMatrixWorld(true);
    _m3.copy(this.mesh.matrixWorld).invert();
    const set = (name) => {
      const body = rd.bodies[name];
      const t = body.translation(), r = body.rotation();
      _m1.compose(_v1.set(t.x, t.y, t.z), _q1.set(r.x, r.y, r.z, r.w), _v2.set(1, 1, 1));
      const bone = this.bones[name];
      // local = parentWorld^-1 * world
      _m2.copy(bone.parent.matrixWorld).invert().multiply(_m1);
      _m2.decompose(bone.position, bone.quaternion, _v2);
      bone.updateMatrixWorld(true);
    };
    set('hips');
    this.bones.spine.updateMatrixWorld(true);
    set('head');
    set('armL');
    set('armR');
    set('thighL');
    set('thighR');
    this.bones.foreL.rotation.set(-0.3, 0, 0);
    this.bones.foreR.rotation.set(-0.3, 0, 0);
    this.bones.shinL.rotation.set(0.2, 0, 0);
    this.bones.shinR.rotation.set(0.2, 0, 0);
  }

  ragdollPosition(out) {
    if (!this.ragdoll) return this.group.getWorldPosition(out);
    const t = this.ragdoll.bodies.hips.translation();
    return out.set(t.x, t.y, t.z);
  }

  endRagdoll() {
    if (!this.ragdoll) return;
    for (const body of Object.values(this.ragdoll.bodies)) this.ragdoll.physics.removeBody(body);
    this.ragdoll = null;
    for (let i = 1; i < BONES.length; i++) {
      const bone = this.mesh.skeleton.bones[i];
      bone.position.copy(this.rest[i]);
      bone.quaternion.identity();
    }
    if (this.tag) this.tag.visible = true;
  }

  dispose() {
    this.endRagdoll();
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
    this.mesh.skeleton.dispose();
  }
}
