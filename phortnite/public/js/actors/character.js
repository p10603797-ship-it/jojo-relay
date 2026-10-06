// Stylised human: one skinned mesh per character (single draw call) built by humanoid.js,
// procedural animation with two-bone IK for the hands (guns, glider), crossfades between pose
// families, a lighter far LOD, weapon attachment, glider, name tag and a Rapier ragdoll on death.
import * as THREE from 'three';
import { SKINS, ANIM, WEAPONS } from '../../shared/constants.js';
import { itemModel, itemMaterial } from '../combat/weaponModels.js';
import { gliderGeometry } from '../world/models.js';
import { GROUP } from '../physics.js';
import { BONE_NAMES, BI as B, rigFor, buildHumanGeometry } from './humanoid.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (cur, target, rate, dt) => cur + (target - cur) * Math.min(1, dt * rate);

const geoCache = new Map();
const gliderCache = new Map();
let charMat = null;

function getGeometry(skin, lod = 0) {
  const k = skin * 4 + lod;
  let g = geoCache.get(k);
  if (!g) geoCache.set(k, (g = buildHumanGeometry(skin, lod)));
  return g;
}

// The far LOD of a skin is built in the background (one mesh per tick) so the first character to
// walk away from the camera does not stall a frame.
const lodQueue = [];
let lodTimer = 0;
function drainLods() {
  lodTimer = 0;
  const k = lodQueue.shift();
  if (k !== undefined && !geoCache.has(k)) geoCache.set(k, buildHumanGeometry(k >> 2, k & 3));
  if (lodQueue.length) lodTimer = setTimeout(drainLods, 40);
}
function queueLod(skin) {
  const k = skin * 4 + 1;
  if (geoCache.has(k) || lodQueue.includes(k)) return;
  lodQueue.push(k);
  if (!lodTimer) lodTimer = setTimeout(drainLods, 40);
}

// Far characters swap to a lighter mesh (same skeleton). The camera is captured from the render
// callback so no hook in the game loop is needed; zoomed (scoped) views count as closer.
const camPos = new THREE.Vector3();
let camKnown = false, camZoom = 1;
const BASE_FOCAL = 1 / Math.tan((70 * Math.PI) / 360);
function captureCamera(renderer, scene, camera) {
  camPos.setFromMatrixPosition(camera.matrixWorld);
  camZoom = camera.projectionMatrix.elements[5] / BASE_FOCAL || 1;
  camKnown = true;
}
const LOD_FAR = 13, LOD_NEAR = 11;

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

// ------------------------------------------------------------------ weapon holds
const GUN_SCALE = 1.3, ITEM_SCALE = 1.15;
// o: gun origin (the grip) relative to the chest in the aim frame (x: left+, y: up, z: forward);
// ads: the same while aiming down sights; r/l: right/left hand grip points in gun space (before
// GUN_SCALE); blade: how far the shoulders turn (left shoulder forward) behind the gun.
const HOLDS = {
  rifle: { o: [-0.135, 0.13, 0.22], ads: [-0.09, 0.19, 0.21], r: [0, -0.075, 0], l: [0, -0.045, 0.24], blade: 0.6, lr: 'under' },
  smg: { o: [-0.13, 0.12, 0.25], ads: [-0.085, 0.18, 0.24], r: [0, -0.072, -0.015], l: [0, -0.04, 0.2], blade: 0.55, lr: 'under' },
  shotgun: { o: [-0.135, 0.13, 0.2], ads: [-0.09, 0.185, 0.19], r: [0, -0.07, -0.03], l: [0, -0.05, 0.31], blade: 0.65, lr: 'under' },
  pistol: { o: [-0.04, 0.16, 0.36], ads: [-0.03, 0.2, 0.36], r: [0, -0.04, -0.005], l: null, blade: 0.08, lr: 'cup' },
  rocket: { o: [-0.17, 0.2, 0.12], ads: [-0.15, 0.22, 0.12], r: [0, -0.04, 0.05], l: [0, -0.06, 0.3], blade: 0.35, lr: 'grip' },
};
function holdFor(key) {
  if (key === 'pistol') return HOLDS.pistol;
  if (key === 'rocket') return HOLDS.rocket;
  if (key === 'smg') return HOLDS.smg;
  const w = hasOwn(WEAPONS, key) ? WEAPONS[key] : null;
  // guns added later: multi-pellet ones are held like the pump, everything else like the AR
  if (w && (w.pellets | 0) > 1) return HOLDS.shotgun;
  return HOLDS.rifle;
}
// Hand orientations in gun space. Hand rest frame: fingers -y, palm toward the body midline,
// the hole of the fist along +z (thumb side forward).
const Q_GRIP_R = new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.82, 0, 0));
const Q_GRIP_L = {
  under: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0, -1.2)),
  cup: new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.75, 0, 0)),
  grip: new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.57, 0, 0)),
};
// glider bar (glider space): fist hole along the bar, palms forward, fingers over the top
const basisQuat = (x, y, z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z)));
const Q_BAR = [basisQuat([0, 0, -1], [0, -1, 0], [-1, 0, 0]), basisQuat([0, 0, 1], [0, -1, 0], [1, 0, 0])];
// wrist -> centre of the closed fist, in hand space
const PALM = { L: new THREE.Vector3(-0.017, -0.074, 0.004), R: new THREE.Vector3(0.017, -0.074, 0.004) };

// scratch objects (no per-frame allocations)
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _mA = new THREE.Matrix4(), _mB = new THREE.Matrix4();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _S = new THREE.Vector3(), _T = new THREE.Vector3(), _E = new THREE.Vector3(), _P = new THREE.Vector3();
const _d = new THREE.Vector3(), _u1 = new THREE.Vector3(), _l1 = new THREE.Vector3(), _n1 = new THREE.Vector3();
const _y1 = new THREE.Vector3(), _z1 = new THREE.Vector3(), _y2 = new THREE.Vector3(), _z2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _qMesh = new THREE.Quaternion(), _qGun = new THREE.Quaternion(), _qHand = new THREE.Quaternion();
const _qAim = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _gunPos = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
const _tR = new THREE.Vector3(), _tL = new THREE.Vector3(), _qR = new THREE.Quaternion(), _qL = new THREE.Quaternion();
const _poleR = new THREE.Vector3(), _poleL = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const REST_N = new THREE.Vector3(-1, 0, 0); // elbow hinge: the forearm flexes toward +z

/** Rotation taking the (axis a1, bend normal n1) frame onto (a2, n2). a1/a2 must be unit length. */
function frameQuat(a1, n1, a2, n2, out) {
  _y1.copy(n1).addScaledVector(a1, -n1.dot(a1)).normalize(); _z1.crossVectors(a1, _y1);
  _y2.copy(n2).addScaledVector(a2, -n2.dot(a2)).normalize(); _z2.crossVectors(a2, _y2);
  _mA.makeBasis(a1, _y1, _z1).transpose();
  _mB.makeBasis(a2, _y2, _z2).multiply(_mA);
  return out.setFromRotationMatrix(_mB);
}

export class Character {
  constructor(skin = 0, name = '', opts = {}) {
    skin = SKINS[skin] ? skin | 0 : 0;
    this.skin = skin;
    if (!charMat) charMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
    this.group = new THREE.Group();
    this.model = new THREE.Group();
    this.group.add(this.model);
    const geo = getGeometry(skin);
    queueLod(skin);
    const rig = rigFor(skin);
    const RIG = rig.list;
    const bones = RIG.map(([n]) => { const b = new THREE.Bone(); b.name = n; return b; });
    RIG.forEach(([, parent, p], i) => {
      if (parent < 0) bones[i].position.set(...p);
      else {
        const pp = RIG[parent][2];
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
    this.mesh.onBeforeRender = captureCamera;
    this.model.add(this.mesh);
    this.bones = Object.fromEntries(BONE_NAMES.map((n, i) => [n, bones[i]]));
    this.rest = bones.map((b) => b.position.clone());
    this.lod = 0;

    // two-bone IK data per arm (rest directions in model space = bone space: rest rotations are identity)
    this.ik = {};
    for (const s of ['L', 'R']) {
      const P = rig.pos;
      const a = new THREE.Vector3().fromArray(P[`arm${s}`]), f = new THREE.Vector3().fromArray(P[`fore${s}`]), h = new THREE.Vector3().fromArray(P[`hand${s}`]);
      this.ik[s] = {
        clav: this.bones[`clav${s}`], arm: this.bones[`arm${s}`], fore: this.bones[`fore${s}`], hand: this.bones[`hand${s}`],
        up: f.distanceTo(a), lo: h.distanceTo(f),
        restU: f.clone().sub(a).normalize(), restL: h.clone().sub(f).normalize(),
        fk: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
        palm: PALM[s],
      };
    }

    // weapon holders: guns are posed in the aim frame each update; melee/items sit in the right fist
    this.gunHolder = new THREE.Group();
    this.bones.spine.add(this.gunHolder);
    this.handHolder = new THREE.Group();
    this.handHolder.position.copy(PALM.R);
    this.bones.handR.add(this.handHolder);
    this.weaponMesh = null;
    this.weaponKey = null;
    this.weaponRarity = 0;
    this.hold = HOLDS.rifle;
    this.muzzle = new THREE.Object3D();

    const sk = SKINS[skin];
    let gg = gliderCache.get(skin);
    if (!gg) gliderCache.set(skin, (gg = gliderGeometry(sk.outfit, sk.accent)));
    this.glider = new THREE.Mesh(gg, itemMaterial());
    this.glider.position.set(0, 2.45, 0);
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
    this.moveK = 0;
    this.runK = 0;
    this.sprintK = 0;
    this.backK = 0;
    this.hipYaw = 0;
    this.gunK = 0;
    this.adsK = 0;
    this.buildK = 0;
    this.healK = 0;
    // pose-family crossfade (ground / skydive / glide / dance)
    this.poseCls = 0;
    this.xfade = 0;
    this.snapQ = bones.map(() => new THREE.Quaternion());
    this.snapP = bones.map(() => new THREE.Vector3());
    this.snapModelQ = new THREE.Quaternion();
    this.snapModelP = new THREE.Vector3();
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
    if (this.weaponKey === key && this.weaponRarity === rarity) return;
    this.weaponKey = key;
    this.weaponRarity = rarity;
    if (this.weaponMesh) this.weaponMesh.parent.remove(this.weaponMesh);
    this.weaponMesh = null;
    if (!key) return;
    const m = itemModel(key, rarity);
    const mesh = new THREE.Mesh(m.geo, itemMaterial());
    mesh.castShadow = true;
    const isWeapon = hasOwn(WEAPONS, key);
    mesh.scale.setScalar(isWeapon ? GUN_SCALE : ITEM_SCALE);
    if (key === 'pickaxe' || (isWeapon && WEAPONS[key].melee)) {
      mesh.rotation.set(Math.PI / 2 + 0.2, 0, 0);
      this.handHolder.add(mesh);
    } else if (isWeapon) {
      // any gun, including ones added later: posed by the aim frame, hands placed by IK
      this.hold = holdFor(key);
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
    return this.bones.chest.getWorldPosition(out).add(_v1.set(0, 0.17, 0));
  }

  headWorld(out) { return this.bones.head.getWorldPosition(out).add(_v1.set(0, 0.07, 0)); }

  playSwing() { this.swing = 1; }
  kick(amount) { this.recoil = Math.min(1, this.recoil + amount); }

  /** Swap to the light mesh when far from the camera (hysteresis avoids flicker). */
  updateLod() {
    if (!camKnown) return;
    const p = this.group.position;
    const d = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z) / Math.max(1, camZoom);
    const lod = this.lod ? (d > LOD_NEAR ? 1 : 0) : (d > LOD_FAR ? 1 : 0);
    if (lod !== this.lod) {
      this.lod = lod;
      this.mesh.geometry = getGeometry(this.skin, lod);
    }
  }

  /**
   * s = { anim, speed, moveAngle, pitch, ads, gun, building, healing, reload (0..1 or -1), dt }
   */
  update(dt, s) {
    this.updateLod();
    if (this.ragdoll) { this.updateRagdoll(dt); return; }
    this.time += dt;
    const anim = s.anim | 0;
    const cls = anim === ANIM.SKYDIVE ? 1 : anim === ANIM.GLIDE ? 2 : anim === ANIM.DANCE ? 3 : 0;
    if (cls !== this.poseCls) { this.snapshot(); this.poseCls = cls; this.xfade = 1; }
    this.swing = Math.max(0, this.swing - dt * 3.2);
    this.recoil = Math.max(0, this.recoil - dt * 9);

    // reset pose
    const bones = this.mesh.skeleton.bones;
    for (let i = 1; i < bones.length; i++) {
      bones[i].position.copy(this.rest[i]);
      bones[i].quaternion.identity();
    }
    this.model.rotation.set(0, 0, 0);
    this.model.position.set(0, 0, 0);
    this.glider.visible = anim === ANIM.GLIDE;

    if (cls === 1) this.poseSkydive(dt, s);
    else if (cls === 2) this.poseGlide(dt, s);
    else if (cls === 3) this.poseDance(dt, s);
    else this.poseGround(dt, s);

    if (this.xfade > 0) {
      const w = sstep(0, 1, this.xfade);
      for (let i = 1; i < bones.length; i++) {
        bones[i].quaternion.slerp(this.snapQ[i], w);
        bones[i].position.lerp(this.snapP[i], w);
      }
      this.model.quaternion.slerp(this.snapModelQ, w);
      this.model.position.lerp(this.snapModelP, w);
      this.xfade = Math.max(0, this.xfade - dt * 4.5);
    }
  }

  snapshot() {
    const bones = this.mesh.skeleton.bones;
    for (let i = 1; i < bones.length; i++) { this.snapQ[i].copy(bones[i].quaternion); this.snapP[i].copy(bones[i].position); }
    this.snapModelQ.copy(this.model.quaternion);
    this.snapModelP.copy(this.model.position);
  }

  // ------------------------------------------------------------------ poses
  poseGround(dt, s) {
    const b = this.bones, t = this.time;
    const anim = s.anim | 0;
    const speed = s.speed || 0;
    const pitch = s.pitch || 0;
    const bend = pitch > 0 ? pitch : pitch * 0.55; // torso share of the aim pitch
    const moving = speed > 0.4;
    let ma = s.moveAngle || 0;
    const back = moving && Math.abs(ma) > 1.9;
    if (back) ma = ma > 0 ? ma - Math.PI : ma + Math.PI;
    const crouch = anim === ANIM.CROUCH || anim === ANIM.CROUCH_WALK;
    const gun = !!s.gun && !s.building && !s.healing;
    this.crouchK = approach(this.crouchK, crouch ? 1 : 0, 12, dt);
    this.airK = approach(this.airK, anim === ANIM.AIR ? 1 : 0, 10, dt);
    this.moveK = approach(this.moveK, moving ? 1 : 0, 8, dt);
    this.runK = approach(this.runK, Math.min(1, speed / 6.2), 6, dt);
    this.sprintK = approach(this.sprintK, anim === ANIM.SPRINT ? 1 : 0, 6, dt);
    this.backK = approach(this.backK, back ? 1 : 0, 8, dt);
    this.hipYaw = approach(this.hipYaw, moving ? clamp(ma, -0.75, 0.75) : 0, 10, dt);
    this.gunK = approach(this.gunK, gun ? 1 : 0, 12, dt);
    this.adsK = approach(this.adsK, gun && s.ads ? 1 : 0, 12, dt);
    this.buildK = approach(this.buildK, s.building ? 1 : 0, 10, dt);
    this.healK = approach(this.healK, s.healing && !s.building ? 1 : 0, 10, dt);
    this.phase += dt * (3.2 + speed * 1.35) * (back ? -1 : 1) * (moving ? 1 : 0);
    const mk = this.moveK, rk = this.runK, sk = this.sprintK, ck = this.crouchK, ak = this.airK, gk = this.gunK;
    const p = this.phase;
    this.showWeapon(!s.building);

    // ---- legs: stride with knee lift in the swing, feet kept level with heel strike / toe off
    const amp = mk * (0.3 + 0.48 * rk + 0.14 * sk) * (1 - 0.45 * ck);
    const stanceFlex = 0.16 + 0.2 * rk, swingFlex = 0.75 + 0.75 * rk + 0.35 * sk;
    const idle = (1 - mk) * (1 - ck) * (1 - ak);
    for (let i = 0; i < 2; i++) {
      const ph = p + i * Math.PI;
      const sp = Math.sin(ph), cp = Math.cos(ph);
      const thigh = i ? b.thighR : b.thighL, shin = i ? b.shinR : b.shinL, foot = i ? b.footR : b.footL, toe = i ? b.toeR : b.toeL;
      let tx = -sp * amp;
      const lift = Math.max(0, Math.cos(ph + 0.45));
      let kx = 0.05 + mk * (stanceFlex * Math.max(0, -cp) + swingFlex * lift * lift) * (1 - 0.4 * ck);
      let fx = -(tx + kx) * 0.85 + mk * (0.28 * Math.max(0, -Math.sin(ph + 0.5)) - 0.18 * Math.max(0, sp));
      let toeX = -mk * 0.45 * Math.max(0, -Math.sin(ph + 0.9)) * Math.max(0, -cp);
      // idle: weight on the right leg, left knee relaxed
      kx += idle * (i ? 0.02 : 0.1);
      tx += idle * (i ? 0.02 : -0.06);
      fx += idle * (i ? -0.02 : -0.03);
      // crouch: deep knee bend, feet flat, one foot a little ahead
      tx += -1.15 * ck - (i ? -0.1 : 0.12) * ck * (1 - mk);
      kx += 1.75 * ck;
      fx += -0.6 * ck;
      // airborne tuck
      if (ak > 0.01) {
        tx = lerp(tx, i ? 0.18 : -0.75, ak);
        kx = lerp(kx, i ? 0.6 : 1.25, ak);
        fx = lerp(fx, 0.35, ak);
        toeX *= 1 - ak;
      }
      const side = i ? -1 : 1;
      const spread = 0.05 + 0.06 * ck + 0.05 * gk * (1 - mk);
      thigh.rotation.set(tx, 0, side * spread);
      shin.rotation.set(kx, 0, -side * spread * 0.6);
      foot.rotation.set(fx, side * 0.06, 0);
      toe.rotation.set(toeX, 0, 0);
    }

    // ---- pelvis and torso
    const bob = -mk * (0.012 + 0.03 * rk) * Math.abs(Math.cos(p)) + mk * 0.008;
    const breathe = Math.sin(t * 1.7);
    b.hips.position.y += bob - 0.31 * ck + (1 - mk) * Math.sin(t * 0.9) * 0.003;
    b.hips.position.z -= 0.06 * ck;
    b.hips.position.x -= idle * 0.016 * (1 - gk); // idle weight shift onto the right leg
    const lean = mk * (0.04 + 0.08 * rk + 0.16 * sk) - this.backK * mk * 0.1;
    const twist = Math.sin(p) * mk * (0.1 + 0.06 * rk);
    b.hips.rotation.set(0.04 * mk, this.hipYaw - twist, Math.cos(p) * 0.045 * mk - idle * 0.03 * (1 - gk));
    const blade = this.hold.blade * gk;
    b.spine.rotation.set(lean * 0.6 + 0.22 * ck - bend * 0.25 * gk, -this.hipYaw * 0.5, 0);
    b.chest.rotation.set(lean * 0.4 + 0.1 * ck - bend * 0.32 * gk + breathe * 0.012 * (1 - mk), -this.hipYaw * 0.5 + twist * 1.3 * (1 - gk) - blade, 0);
    b.neck.rotation.set(-lean * 0.4 - 0.12 * ck - pitch * (0.15 + 0.1 * (1 - gk)), blade * 0.5, 0);
    b.head.rotation.set(-lean * 0.5 - 0.12 * ck - pitch * (0.22 + 0.25 * (1 - gk)), blade * 0.45, 0.16 * this.adsK);
    b.clavL.rotation.set(0, 0, breathe * 0.012 * (1 - mk));
    b.clavR.rotation.set(0, 0, -breathe * 0.012 * (1 - mk));

    // ---- arms (forward kinematics; a held gun overrides them with IK below)
    const armAmp = mk * (0.32 + 0.5 * rk + 0.25 * sk) * (1 - 0.5 * ck);
    const elbow = 0.18 + mk * (0.35 + 0.75 * rk + 0.35 * sk);
    const sw = Math.sin(p) * armAmp;
    let lx = sw, rx = -sw;
    let lz = 0.07 + 0.05 * rk * mk, rz = -lz;
    let lfx = -(elbow + Math.max(0, -lx) * 0.5), rfx = -(elbow + Math.max(0, -rx) * 0.5);
    let rhx = 0;
    // pickaxe (or an item) in the right fist: carried forward, swings less
    const tool = !!this.weaponMesh && this.weaponMesh.parent === this.handHolder;
    if (tool) { rx = rx * 0.5 - 0.25; rfx = Math.min(rfx, -0.75); rhx = 0.15; }
    if (ak > 0.01) { lx = lerp(lx, -0.35, ak); rx = lerp(rx, -0.35, ak); lz += 0.4 * ak; rz -= 0.4 * ak; }
    if (ck > 0.01 && !tool) { lx -= 0.25 * ck; rx -= 0.25 * ck; }
    const bk = this.buildK, hk = this.healK;
    if (bk > 0.01) {
      const g = Math.sin(t * 5.5) * 0.1;
      lx = lerp(lx, -1.0, bk); lfx = lerp(lfx, -1.1, bk); lz = lerp(lz, 0.25, bk);
      rx = lerp(rx, -1.25 + g, bk); rfx = lerp(rfx, -0.55 - g, bk); rz = lerp(rz, -0.05, bk);
      rhx = lerp(rhx, -0.2, bk);
    }
    if (hk > 0.01) {
      const rub = Math.sin(t * 10);
      lx = lerp(lx, -0.5, hk); lfx = lerp(lfx, -1.5 + rub * 0.22, hk); lz = lerp(lz, 0.3, hk);
      rx = lerp(rx, -0.6, hk); rfx = lerp(rfx, -1.45, hk); rz = lerp(rz, -0.25, hk); rhx = lerp(rhx, -0.35, hk);
      b.head.rotation.x += 0.3 * hk;
    }
    // pickaxe swing: wind up overhead, strike down with the torso, recover
    if (this.swing > 0 && !gun && bk < 0.5) {
      const st = 1 - this.swing;
      const up = sstep(0, 0.3, st), hit = sstep(0.3, 0.52, st), rec = sstep(0.6, 1, st);
      const w = up * (1 - rec);
      rx = lerp(rx, lerp(-2.7, 0.35, hit), w);
      rfx = lerp(rfx, lerp(-1.0, -0.25, hit), w);
      rz = lerp(rz, lerp(-0.25, -0.05, hit), w);
      rhx = lerp(rhx, lerp(-0.5, 0.45, hit), w);
      lx = lerp(lx, lerp(-0.6, 0.2, hit), w);
      lfx = lerp(lfx, -0.9, w);
      b.chest.rotation.y += lerp(-0.35, 0.3, hit) * w;
      b.spine.rotation.x += lerp(-0.12, 0.25, hit) * w;
      b.spine.rotation.y += lerp(-0.1, 0.15, hit) * w;
    }
    b.armL.rotation.set(lx, 0, lz);
    b.armR.rotation.set(rx, 0, rz);
    b.foreL.rotation.set(lfx, 0, 0);
    b.foreR.rotation.set(rfx, 0, 0);
    b.handR.rotation.set(rhx, 0, 0);
    const fist = 0.15 + 0.25 * rk * mk;
    b.fingL.rotation.set(0, 0, -fist);
    b.fingR.rotation.set(0, 0, tool ? 0.35 : fist);

    // ---- gun: the aim frame drives the weapon, IK puts both hands on it
    if (this.weaponMesh && this.weaponMesh.parent === this.gunHolder) this.aimGun(s, gk);
  }

  aimGun(s, gk) {
    const b = this.bones, h = this.hold;
    const pitch = s.pitch || 0;
    const ads = this.adsK, rc = this.recoil;
    const reload = s.reload >= 0 ? s.reload : -1;
    // sprinting carries the gun low across the chest
    const port = this.sprintK * (1 - ads);
    b.chest.updateWorldMatrix(true, false);
    _qMesh.setFromRotationMatrix(this.mesh.matrixWorld);
    // gun origin: chest + aim-rotated offset; recoil pushes it back and climbs the muzzle
    const rl = reload >= 0 ? Math.sin(reload * Math.PI) : 0;
    _qAim.setFromAxisAngle(_xAxis, -pitch * (1 - port));
    _v2.set(lerp(h.o[0], h.ads[0], ads) + 0.07 * port, lerp(h.o[1], h.ads[1], ads) - rl * 0.05 - 0.1 * port, lerp(h.o[2], h.ads[2], ads) - rc * 0.07 - 0.04 * port)
      .applyQuaternion(_qAim).applyQuaternion(_qMesh);
    _gunPos.setFromMatrixPosition(b.chest.matrixWorld).add(_v2);
    _e1.set(-pitch * (1 - port) - rc * 0.14 + rl * 0.2 + 0.55 * port, 0.6 * port, rl * 0.5 + 0.3 * port);
    _qGun.setFromEuler(_e1).premultiply(_qMesh);
    _m1.compose(_gunPos, _qGun, _one);
    // holder local = spine^-1 * gunWorld
    _m2.copy(b.spine.matrixWorld).invert().multiply(_m1);
    _m2.decompose(this.gunHolder.position, this.gunHolder.quaternion, this.gunHolder.scale);
    if (gk < 0.002) return;

    // hand targets (world)
    _tR.fromArray(h.r).multiplyScalar(GUN_SCALE).applyMatrix4(_m1);
    _qR.copy(_qGun).multiply(Q_GRIP_R);
    if (h.lr === 'cup') {
      _tL.set(h.r[0] + 0.03, h.r[1] - 0.025, h.r[2] + 0.012).multiplyScalar(GUN_SCALE).applyMatrix4(_m1);
      _qL.copy(_qGun).multiply(Q_GRIP_L.cup);
    } else {
      _tL.fromArray(h.l).multiplyScalar(GUN_SCALE).applyMatrix4(_m1);
      _qL.copy(_qGun).multiply(Q_GRIP_L[h.lr]);
    }
    if (reload >= 0 && h.lr !== 'cup') {
      // left hand: to the magazine, down to the belt pouch, back to the mag, back to the grip
      _v3.set(0, -0.12, 0.17).multiplyScalar(GUN_SCALE).applyMatrix4(_m1);
      _v4.set(0.1, 1.0, 0.12).applyMatrix4(this.mesh.matrixWorld);
      const toMag = sstep(0, 0.18, reload) * (1 - sstep(0.78, 1, reload));
      const toBelt = sstep(0.22, 0.42, reload) * (1 - sstep(0.48, 0.7, reload));
      _tL.lerp(_v3, toMag);
      _tL.lerp(_v4, toBelt);
      _qL.slerp(_qR, toMag * 0.6);
    }
    // wrist = grip - handRotation * palmOffset
    _tR.sub(_v1.copy(this.ik.R.palm).applyQuaternion(_qR));
    _tL.sub(_v1.copy(this.ik.L.palm).applyQuaternion(_qL));
    _poleR.set(-0.75, -1, -0.45).normalize().applyQuaternion(_qMesh);
    _poleL.set(0.45, -1, -0.15).normalize().applyQuaternion(_qMesh);
    this.solveArm(this.ik.R, _tR, _poleR, _qR, gk);
    this.solveArm(this.ik.L, _tL, _poleL, _qL, gk);
    b.fingR.rotation.set(0, 0, lerp(b.fingR.rotation.z, 0.3, gk));
    b.fingL.rotation.set(0, 0, lerp(b.fingL.rotation.z, -0.5, gk));
  }

  /** Two-bone IK: wrist to `target` (world), elbow toward `pole`, optional world hand rotation; blended with FK by k. */
  solveArm(A, target, pole, handQ, k) {
    const fk = A.fk;
    fk[0].copy(A.arm.quaternion); fk[1].copy(A.fore.quaternion); fk[2].copy(A.hand.quaternion);
    A.clav.updateWorldMatrix(false, false);
    A.arm.updateWorldMatrix(false, false);
    _S.setFromMatrixPosition(A.arm.matrixWorld);
    _q1.setFromRotationMatrix(A.clav.matrixWorld); // parent world rotation
    _d.subVectors(target, _S);
    const a = A.up, c = A.lo;
    const dist = clamp(_d.length(), Math.abs(a - c) + 1e-3, a + c - 1e-3);
    _d.normalize();
    const cosA = clamp((a * a + dist * dist - c * c) / (2 * a * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    _P.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_P.lengthSq() < 1e-8) _P.set(0, -1, 0).addScaledVector(_d, _d.y);
    _P.normalize();
    _E.copy(_S).addScaledVector(_d, a * cosA).addScaledVector(_P, a * sinA);
    _T.copy(_S).addScaledVector(_d, dist);
    _u1.subVectors(_E, _S).normalize();
    _l1.subVectors(_T, _E).normalize();
    _n1.crossVectors(_u1, _l1);
    if (_n1.lengthSq() < 1e-8) _n1.crossVectors(_u1, _P);
    _n1.normalize();
    frameQuat(A.restU, REST_N, _u1, _n1, _q2); // upper arm world rotation
    frameQuat(A.restL, REST_N, _l1, _n1, _q3); // forearm world rotation
    _q4.copy(_q1).invert().multiply(_q2);
    A.arm.quaternion.slerpQuaternions(fk[0], _q4, k);
    _q4.copy(_q2).invert().multiply(_q3);
    A.fore.quaternion.slerpQuaternions(fk[1], _q4, k);
    if (handQ) {
      _q4.copy(_q3).invert().multiply(handQ);
      A.hand.quaternion.slerpQuaternions(fk[2], _q4, k);
    }
  }

  poseSkydive(dt, s) {
    const b = this.bones, t = this.time;
    this.showWeapon(false);
    this.model.rotation.x = 1.25;
    this.model.position.y = 0.9;
    const f = Math.sin(t * 6) * 0.06, g = Math.cos(t * 5) * 0.08;
    b.spine.rotation.set(-0.12, 0, 0);
    b.chest.rotation.set(-0.1, 0, 0);
    b.neck.rotation.set(-0.35, 0, 0);
    b.head.rotation.set(-0.6, 0, 0);
    // arms out, elbows bent so the forearms point ahead (classic box position)
    b.armL.rotation.set(-0.15, 0, 1.3 + f);
    b.armR.rotation.set(-0.15, 0, -1.3 - f);
    b.foreL.rotation.set(-0.25, 0, 1.05);
    b.foreR.rotation.set(-0.25, 0, -1.05);
    b.handL.rotation.set(0, 0, 0.2);
    b.handR.rotation.set(0, 0, -0.2);
    b.fingL.rotation.set(0, 0, 0.7);
    b.fingR.rotation.set(0, 0, -0.7);
    // legs apart, knees bent, feet up
    b.thighL.rotation.set(0.1, 0, 0.3);
    b.thighR.rotation.set(0.1, 0, -0.3);
    b.shinL.rotation.set(1.15 + g, 0, 0);
    b.shinR.rotation.set(1.15 - g, 0, 0);
    b.footL.rotation.set(0.55, 0, 0);
    b.footR.rotation.set(0.55, 0, 0);
  }

  poseGlide(dt, s) {
    const b = this.bones, t = this.time;
    this.showWeapon(false);
    this.model.rotation.x = 0.14;
    const sway = Math.sin(t * 2.2);
    b.spine.rotation.set(-0.06, 0, 0);
    b.chest.rotation.set(-0.05, 0, 0);
    b.neck.rotation.set(-0.1, 0, 0);
    b.head.rotation.set(-(s.pitch || 0) * 0.3, 0, 0);
    b.thighL.rotation.set(-0.35 + sway * 0.06, 0, 0.06);
    b.thighR.rotation.set(0.05 - sway * 0.06, 0, -0.06);
    b.shinL.rotation.set(0.5, 0, 0);
    b.shinR.rotation.set(0.3, 0, 0);
    b.footL.rotation.set(0.45, 0, 0);
    b.footR.rotation.set(0.5, 0, 0);
    // hands on the glider bar (IK)
    b.chest.updateWorldMatrix(true, false);
    this.glider.updateWorldMatrix(false, false);
    _qMesh.setFromRotationMatrix(this.mesh.matrixWorld);
    _q4.setFromRotationMatrix(this.glider.matrixWorld);
    for (let i = 0; i < 2; i++) {
      const A = i ? this.ik.R : this.ik.L;
      _tL.set(i ? -0.29 : 0.29, -0.33, 0.0).applyMatrix4(this.glider.matrixWorld);
      _qHand.copy(_q4).multiply(Q_BAR[i]);
      _tL.sub(_v1.copy(A.palm).applyQuaternion(_qHand));
      _poleL.set(i ? -1 : 1, -0.2, -0.7).normalize().applyQuaternion(_qMesh);
      this.solveArm(A, _tL, _poleL, _qHand, 1);
    }
    b.fingL.rotation.set(0, 0, -0.4);
    b.fingR.rotation.set(0, 0, 0.4);
  }

  poseDance(dt, s) {
    // the floss: straight arms swing side to side, crossing in front / behind; hips counter-swing
    const b = this.bones;
    this.showWeapon(false);
    const t = this.time * 7.5;
    const sw = Math.sin(t);
    const fb = Math.tanh(Math.cos(t) * 3); // which arm is in front
    b.hips.position.x = -sw * 0.07;
    b.hips.position.y -= 0.025 + Math.abs(sw) * 0.01;
    b.hips.rotation.set(0, sw * 0.12, sw * 0.14);
    b.spine.rotation.set(0.04, -sw * 0.1, -sw * 0.18);
    b.chest.rotation.set(0.03, 0, -sw * 0.12);
    b.neck.rotation.set(0, 0, sw * 0.12);
    b.head.rotation.set(-0.05, sw * 0.1, sw * 0.16);
    b.armL.rotation.set(fb * 0.5, 0, 0.3 + sw * 0.62);
    b.armR.rotation.set(-fb * 0.5, 0, -0.3 + sw * 0.62);
    b.foreL.rotation.set(-0.12, 0, 0);
    b.foreR.rotation.set(-0.12, 0, 0);
    b.fingL.rotation.set(0, 0, -0.4);
    b.fingR.rotation.set(0, 0, 0.4);
    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;
      const thigh = i ? b.thighR : b.thighL, shin = i ? b.shinR : b.shinL, foot = i ? b.footR : b.footL;
      const k = 0.18 + Math.max(0, side * sw) * 0.25;
      thigh.rotation.set(-k * 0.6, 0, side * 0.08 - sw * 0.12);
      shin.rotation.set(k, 0, 0);
      foot.rotation.set(-k * 0.4, 0, sw * 0.12);
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
    this.glider.visible = false;
    if (this.tag) this.tag.visible = false;
    // the torso chain between the hips and the head/arms is rigid while ragdolled: straighten it
    // first so the physics bodies line up with the bones they drive
    for (const n of ['spine', 'chest', 'neck', 'clavL', 'clavR']) {
      this.bones[n].quaternion.identity();
      this.bones[n].position.copy(this.rest[B[n]]);
    }
    this.group.updateMatrixWorld(true);
    const segs = [
      // masses in kg; keeping the ratios modest keeps the joints stable
      { bone: 'hips', shape: () => R.ColliderDesc.capsule(0.22, 0.17).setTranslation(0, 0.3, 0), mass: 14 },
      { bone: 'head', shape: () => R.ColliderDesc.ball(0.14).setTranslation(0, 0.1, 0.01), mass: 4 },
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
  }

  updateRagdoll(dt) {
    const rd = this.ragdoll;
    rd.t += dt;
    // group/model act as the frame of reference
    this.model.updateMatrixWorld(true);
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
    // limp secondary joints
    const b = this.bones;
    b.foreL.rotation.set(-0.35, 0, 0.1);
    b.foreR.rotation.set(-0.35, 0, -0.1);
    b.handL.rotation.set(0.3, 0, 0);
    b.handR.rotation.set(0.3, 0, 0);
    b.fingL.rotation.set(0, 0, 0.3);
    b.fingR.rotation.set(0, 0, -0.3);
    b.shinL.rotation.set(0.25, 0, 0);
    b.shinR.rotation.set(0.2, 0, 0);
    b.footL.rotation.set(0.4, 0, 0);
    b.footR.rotation.set(0.45, 0, 0);
    b.toeL.rotation.set(0, 0, 0);
    b.toeR.rotation.set(0, 0, 0);
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
    const bones = this.mesh.skeleton.bones;
    for (let i = 1; i < bones.length; i++) {
      bones[i].position.copy(this.rest[i]);
      bones[i].quaternion.identity();
    }
    this.poseCls = 0; // no crossfade out of the corpse pose
    this.xfade = 0;
    if (this.tag) this.tag.visible = true;
  }

  dispose() {
    this.endRagdoll();
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
    this.mesh.skeleton.dispose();
  }
}
