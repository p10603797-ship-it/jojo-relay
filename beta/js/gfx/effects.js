// GPU-friendly effects: instanced billboard particles, tracers, decals, physics debris,
// pooled lights. Everything is pre-allocated so gameplay never allocates per frame.
import * as THREE from 'three';
import { GROUP } from '../physics.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

class Particles {
  constructor(max, texture, additive) {
    this.max = max;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aRot', this.aRot);
    geo.instanceCount = 0;
    this.geo = geo;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]);
    uniforms.map.value = texture;
    this.mat = new THREE.ShaderMaterial({
      uniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */`
        #include <fog_pars_vertex>
        attribute vec4 aPos;
        attribute vec4 aCol;
        attribute float aRot;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(aRot), s = sin(aRot);
          vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aPos.w;
          vec3 world = aPos.xyz + right * p.x + up * p.y;
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv;
          vCol = aCol;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
        #include <fog_pars_fragment>
        uniform sampler2D map;
        varying vec2 vUv;
        varying vec4 vCol;
        void main() {
          vec4 t = texture2D(map, vUv);
          gl_FragColor = vec4(vCol.rgb * t.rgb, vCol.a * t.a);
          if (gl_FragColor.a < 0.004) discard;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 10;
    // SoA state
    const F = (n = max) => new Float32Array(n);
    this.p = F(max * 3); this.v = F(max * 3); this.c = F(max * 3);
    this.life = F(); this.maxLife = F(); this.s0 = F(); this.s1 = F(); this.a0 = F();
    this.rot = F(); this.rotV = F(); this.drag = F(); this.grav = F(); this.fadeIn = F();
    this.n = 0;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a = 1, grav = 0, drag = 0, rotV = 0, fadeIn = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.c[i3] = r; this.c[i3 + 1] = g; this.c[i3 + 2] = b;
    this.life[i] = 0; this.maxLife[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a;
    this.grav[i] = grav; this.drag[i] = drag; this.rot[i] = Math.random() * 6.28; this.rotV[i] = rotV; this.fadeIn[i] = fadeIn;
  }

  update(dt) {
    let n = this.n;
    const P = this.aPos.array, C = this.aCol.array, RT = this.aRot.array;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        // swap-remove
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.v[i3] *= d; this.v[i3 + 1] = this.v[i3 + 1] * d - this.grav[i] * dt; this.v[i3 + 2] *= d;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      this.rot[i] += this.rotV[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      const fi = this.fadeIn[i] > 0 ? Math.min(1, this.life[i] / this.fadeIn[i]) : 1;
      const i4 = i * 4;
      P[i4] = this.p[i3]; P[i4 + 1] = this.p[i3 + 1]; P[i4 + 2] = this.p[i3 + 2];
      P[i4 + 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      C[i4] = this.c[i3]; C[i4 + 1] = this.c[i3 + 1]; C[i4 + 2] = this.c[i3 + 2];
      C[i4 + 3] = this.a0[i] * (1 - t) * (1 - t * 0.3) * fi;
      RT[i] = this.rot[i];
    }
    this.n = n;
    this.geo.instanceCount = n;
    if (n) {
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, n * 4); this.aPos.needsUpdate = true;
      this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, n * 4); this.aCol.needsUpdate = true;
      this.aRot.clearUpdateRanges(); this.aRot.addUpdateRange(0, n); this.aRot.needsUpdate = true;
    }
  }

  copy(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.p[t3 + k] = this.p[f3 + k]; this.v[t3 + k] = this.v[f3 + k]; this.c[t3 + k] = this.c[f3 + k];
    }
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from]; this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from];
    this.a0[to] = this.a0[from]; this.rot[to] = this.rot[from]; this.rotV[to] = this.rotV[from]; this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from]; this.fadeIn[to] = this.fadeIn[from];
  }
}

class Tracers {
  constructor(max) {
    this.max = max;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage); // start + width
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aA', this.aA);
    geo.setAttribute('aB', this.aB);
    geo.setAttribute('aC', this.aC);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec4 aA;
        attribute vec3 aB;
        attribute vec4 aC;
        varying vec4 vC;
        varying float vT;
        void main() {
          vec3 p = mix(aA.xyz, aB, position.y);
          vec3 dir = normalize(aB - aA.xyz + vec3(1e-5));
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          p += side * position.x * aA.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          vC = aC;
          vT = position.y;
        }`,
      fragmentShader: /* glsl */`
        varying vec4 vC;
        varying float vT;
        void main() {
          gl_FragColor = vec4(vC.rgb, vC.a * (0.25 + 0.75 * vT));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
    this.list = [];
  }

  add(ax, ay, az, bx, by, bz, width, r, g, b, a, life) {
    if (this.list.length >= this.max) return;
    this.list.push({ ax, ay, az, bx, by, bz, width, r, g, b, a, life, t: 0 });
  }

  update(dt) {
    let n = 0;
    const A = this.aA.array, Bb = this.aB.array, C = this.aC.array;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const l = this.list[i];
      const k = l.life > 0 ? 1 - l.t / l.life : 1;
      A[n * 4] = l.ax; A[n * 4 + 1] = l.ay; A[n * 4 + 2] = l.az; A[n * 4 + 3] = l.width;
      Bb[n * 3] = l.bx; Bb[n * 3 + 1] = l.by; Bb[n * 3 + 2] = l.bz;
      C[n * 4] = l.r; C[n * 4 + 1] = l.g; C[n * 4 + 2] = l.b; C[n * 4 + 3] = l.a * k;
      n++;
      l.t += dt;
      if (l.t >= l.life) this.list.splice(i, 1);
    }
    this.geo.instanceCount = n;
    if (n) { this.aA.needsUpdate = true; this.aB.needsUpdate = true; this.aC.needsUpdate = true; }
  }
}

class Decals {
  constructor(max, tex) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }), max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.keys = new Array(max).fill(null);
    this.next = 0;
  }

  add(x, y, z, nx, ny, nz, size, key) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    _v.set(nx, ny, nz);
    _q.setFromUnitVectors(_v2.set(0, 0, 1), _v);
    const rq = new THREE.Quaternion().setFromAxisAngle(_v2.set(0, 0, 1), Math.random() * 6.28);
    _q.multiply(rq);
    _m.compose(_v.set(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01), _q, _s.setScalar(size));
    this.mesh.setMatrixAt(i, _m);
    this.keys[i] = key;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  removeKey(key) {
    let dirty = false;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.keys[i] === key) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
        this.keys[i] = null;
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { this.mesh.count = 0; this.next = 0; this.keys.fill(null); }
}

class Debris {
  constructor(physics, mats, perMat = 36) {
    this.physics = physics;
    this.pools = {};
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const [k, mat] of Object.entries(mats)) {
      const mesh = new THREE.InstancedMesh(geo, mat, perMat);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = perMat;
      for (let i = 0; i < perMat; i++) mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      this.pools[k] = { mesh, items: new Array(perMat).fill(null), next: 0 };
    }
  }

  spawn(mat, x, y, z, sx, sy, sz, vx, vy, vz) {
    const pool = this.pools[mat] || this.pools.wood;
    const i = pool.next;
    pool.next = (pool.next + 1) % pool.items.length;
    if (pool.items[i]) this.physics.removeBody(pool.items[i].body);
    const R = this.physics.R;
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setRotation(_q.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3)))
      .setLinvel(vx, vy, vz).setAngvel({ x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 })
      .setLinearDamping(0.1).setAngularDamping(0.3));
    this.physics.collider(R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setDensity(2).setFriction(0.8).setRestitution(0.2),
      null, body, GROUP.DEBRIS, GROUP.WORLD | GROUP.BUILD | GROUP.DEBRIS | GROUP.PROP);
    pool.items[i] = { body, sx, sy, sz, t: 0, life: 2.8 + Math.random() * 1.2 };
  }

  update(dt) {
    for (const pool of Object.values(this.pools)) {
      let dirty = false;
      pool.items.forEach((it, i) => {
        if (!it) return;
        it.t += dt;
        if (it.t > it.life) {
          this.physics.removeBody(it.body);
          pool.items[i] = null;
          pool.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
          dirty = true;
          return;
        }
        const k = Math.min(1, (it.life - it.t) / 0.5);
        const t = it.body.translation(), r = it.body.rotation();
        _m.compose(_v.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(it.sx * k, it.sy * k, it.sz * k));
        pool.mesh.setMatrixAt(i, _m);
        dirty = true;
      });
      if (dirty) pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  clear() {
    for (const pool of Object.values(this.pools)) {
      pool.items.forEach((it, i) => {
        if (it) this.physics.removeBody(it.body);
        pool.items[i] = null;
        pool.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      });
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const MAT_FX = {
  wood: { chip: [0.62, 0.42, 0.24], dust: [0.75, 0.62, 0.45] },
  stone: { chip: [0.55, 0.53, 0.5], dust: [0.72, 0.7, 0.66] },
  metal: { chip: [1.0, 0.85, 0.5], dust: [0.6, 0.62, 0.65], sparks: true },
  grass: { chip: [0.32, 0.55, 0.2], dust: [0.55, 0.5, 0.38] },
  sand: { chip: [0.85, 0.77, 0.55], dust: [0.9, 0.84, 0.66] },
  dirt: { chip: [0.45, 0.33, 0.22], dust: [0.6, 0.5, 0.38] },
  rock: { chip: [0.5, 0.5, 0.48], dust: [0.7, 0.68, 0.64] },
};

export class Effects {
  constructor(scene, physics, sprites, buildMats, quality) {
    this.scene = scene;
    this.quality = quality;
    this.add = new Particles(1200, sprites.soft, true);
    this.alpha = new Particles(900, sprites.smoke, false);
    this.chips = new Particles(600, sprites.soft, false);
    this.tracers = new Tracers(256);
    this.decals = new Decals(160, sprites.hole);
    this.debris = new Debris(physics, buildMats);
    for (const o of [this.add.mesh, this.alpha.mesh, this.chips.mesh, this.tracers.mesh, this.decals.mesh]) scene.add(o);
    for (const p of Object.values(this.debris.pools)) scene.add(p.mesh);
    // muzzle / explosion lights: real PointLights only on High and Ultra (every lit shader pays for
    // them); Low and Medium get an additive halo sprite instead
    this.lights = [0, 1].map(() => ({ light: new THREE.PointLight(0xffb060, 0, 18, 2), t: 0, dur: 0.1, peak: 0 }));
    this.lightsOn = false;
    this.syncLights();
    this._c = new THREE.Color();
  }

  scale() { return this.quality.particles ?? 1; }

  /** Real lights only on High / Ultra (follows quality changes: main.js assigns into this.quality). */
  wantLights() {
    const q = this.quality;
    return !!q.lights && (q.name === 'high' || q.name === 'ultra');
  }

  syncLights() {
    const on = this.wantLights();
    if (on === this.lightsOn) return;
    this.lightsOn = on;
    for (const L of this.lights) {
      if (on) this.scene.add(L.light); else { this.scene.remove(L.light); L.peak = 0; L.light.intensity = 0; }
    }
  }

  flash(x, y, z, intensity, dur, color = 0xffb060, slot = 0) {
    if (!this.lightsOn) {
      // a soft additive glow where the light would have been
      const c = this._c.setHex(color);
      const size = Math.min(8, 0.5 + Math.sqrt(intensity) * 0.3);
      this.add.emit(x, y, z, 0, 0, 0, Math.max(0.06, dur * 0.9), size, size * 1.25, c.r, c.g, c.b, Math.min(0.5, 0.08 + intensity / 400));
      return;
    }
    const L = this.lights[slot];
    L.light.position.set(x, y, z);
    L.light.color.setHex(color);
    L.peak = intensity;
    L.dur = dur;
    L.t = 0;
  }

  muzzle(pos, dir, big = false, local = false) {
    const s = big ? 1.7 : 1;
    this.add.emit(pos.x + dir.x * 0.1, pos.y + dir.y * 0.1, pos.z + dir.z * 0.1, 0, 0, 0, 0.05, 0.55 * s, 0.75 * s, 1, 0.8, 0.45, 1);
    this.add.emit(pos.x + dir.x * 0.3, pos.y + dir.y * 0.3, pos.z + dir.z * 0.3, dir.x * 3, dir.y * 3, dir.z * 3, 0.06, 0.35 * s, 0.2, 1, 0.65, 0.3, 0.9);
    for (let i = 0; i < 3; i++) {
      this.add.emit(pos.x, pos.y, pos.z, dir.x * 18 + (Math.random() - 0.5) * 6, dir.y * 18 + (Math.random() - 0.5) * 6, dir.z * 18 + (Math.random() - 0.5) * 6,
        0.08 + Math.random() * 0.06, 0.06, 0.02, 1, 0.8, 0.4, 1, 6);
    }
    this.alpha.emit(pos.x + dir.x * 0.3, pos.y + dir.y * 0.3, pos.z + dir.z * 0.3, dir.x * 1.5, 0.6, dir.z * 1.5, 0.5, 0.25 * s, 0.9 * s, 0.8, 0.8, 0.8, 0.25, -0.5, 1.5, 0.5);
    if (local) this.flash(pos.x, pos.y, pos.z, big ? 30 : 14, 0.06, 0xffc070, 0);
  }

  impact(x, y, z, nx, ny, nz, mat, intensity = 1) {
    const fx = MAT_FX[mat] || MAT_FX.stone;
    const n = Math.round((4 + 4 * intensity) * this.scale());
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 5;
      this.chips.emit(x, y, z, nx * sp + (Math.random() - 0.5) * 5, ny * sp + Math.random() * 4, nz * sp + (Math.random() - 0.5) * 5,
        0.35 + Math.random() * 0.4, 0.06 + Math.random() * 0.05, 0.04, fx.chip[0], fx.chip[1], fx.chip[2], 1, 14, 0.5);
    }
    this.alpha.emit(x + nx * 0.1, y + ny * 0.1, z + nz * 0.1, nx * 1.2, ny * 1.2 + 0.4, nz * 1.2, 0.7, 0.25, 1.1 * intensity,
      fx.dust[0], fx.dust[1], fx.dust[2], 0.55, -0.3, 2.0, 0.6);
    if (fx.sparks || mat === 'metal') {
      for (let i = 0; i < 8; i++) {
        this.add.emit(x, y, z, nx * 6 + (Math.random() - 0.5) * 10, ny * 6 + Math.random() * 6, nz * 6 + (Math.random() - 0.5) * 10,
          0.2 + Math.random() * 0.2, 0.07, 0.02, 1, 0.75, 0.35, 1, 18);
      }
    }
  }

  hitPlayer(x, y, z, shield, head) {
    const c = shield ? [0.35, 0.75, 1] : head ? [1, 0.85, 0.3] : [1, 1, 1];
    for (let i = 0; i < 10; i++) {
      this.add.emit(x, y, z, (Math.random() - 0.5) * 8, (Math.random() - 0.2) * 7, (Math.random() - 0.5) * 8,
        0.25 + Math.random() * 0.2, 0.12, 0.02, c[0], c[1], c[2], 1, 10);
    }
    this.add.emit(x, y, z, 0, 0, 0, 0.12, 0.3, 0.9, c[0], c[1], c[2], 0.8);
  }

  water(x, z) {
    for (let i = 0; i < 10; i++) {
      this.alpha.emit(x, 0.05, z, (Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2, 0.6, 0.15, 0.5, 0.9, 0.97, 1, 0.8, 12, 0.5);
    }
  }

  explosion(x, y, z, radius = 5) {
    const s = this.scale();
    for (let i = 0; i < 18 * s; i++) {
      const a = Math.random() * 6.28, e = Math.random() * 1.5, sp = 2 + Math.random() * 8;
      this.add.emit(x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp,
        0.4 + Math.random() * 0.4, radius * 0.45, radius * 0.9, 1, 0.55 + Math.random() * 0.25, 0.2, 1, -2, 3, 1.5);
    }
    for (let i = 0; i < 16 * s; i++) {
      const a = Math.random() * 6.28, sp = 1 + Math.random() * 4;
      this.alpha.emit(x + (Math.random() - 0.5) * 2, y + Math.random() * 1.5, z + (Math.random() - 0.5) * 2,
        Math.cos(a) * sp, 1.5 + Math.random() * 3, Math.sin(a) * sp, 2.2 + Math.random() * 1.5, radius * 0.5, radius * 1.4,
        0.32, 0.3, 0.28, 0.75, -0.6, 1.2, 0.4, 0.1);
    }
    for (let i = 0; i < 40 * s; i++) {
      const a = Math.random() * 6.28, e = Math.random() * 1.2, sp = 10 + Math.random() * 18;
      this.add.emit(x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp,
        0.5 + Math.random() * 0.6, 0.12, 0.03, 1, 0.7, 0.3, 1, 16, 0.6);
    }
    this.add.emit(x, y, z, 0, 0, 0, 0.18, radius * 1.6, radius * 2.6, 1, 0.9, 0.7, 1);
    this.flash(x, y + 1, z, 220, 0.35, 0xffa040, 1);
  }

  sparkle(x, y, z, color = [1, 0.85, 0.3], n = 12) {
    for (let i = 0; i < n; i++) {
      this.add.emit(x + (Math.random() - 0.5) * 0.8, y + Math.random() * 0.6, z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 2, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.5, 0.12, 0.02,
        color[0], color[1], color[2], 1, -0.5, 1);
    }
  }

  dust(x, y, z, size = 1, color = [0.75, 0.7, 0.6]) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * 6.28;
      this.alpha.emit(x, y + 0.1, z, Math.cos(a) * 2.5 * size, 0.4 + Math.random(), Math.sin(a) * 2.5 * size, 0.8, 0.4 * size, 1.4 * size,
        color[0], color[1], color[2], 0.45, -0.2, 2.5, 0.5);
    }
  }

  digitize(x, y, z) {
    for (let i = 0; i < 40; i++) {
      this.add.emit(x + (Math.random() - 0.5) * 0.7, y + Math.random() * 1.8, z + (Math.random() - 0.5) * 0.7,
        (Math.random() - 0.5) * 1.2, 1 + Math.random() * 2.5, (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 0.8, 0.14, 0.02,
        0.35, 0.8, 1, 1, -1.2, 0.5);
    }
  }

  /** A shield breaking: blue glass shards and a bright pop. */
  shards(x, y, z) {
    const n = Math.round(22 * Math.max(0.6, this.scale()));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, e = Math.random() * 1.4 - 0.3, sp = 3 + Math.random() * 6;
      this.chips.emit(x, y, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 2, Math.sin(a) * Math.cos(e) * sp,
        0.45 + Math.random() * 0.35, 0.09 + Math.random() * 0.07, 0.05, 0.45, 0.8, 1, 1, 12, 0.4, 14);
    }
    for (let i = 0; i < 10; i++) {
      this.add.emit(x, y, z, (Math.random() - 0.5) * 9, (Math.random() - 0.1) * 7, (Math.random() - 0.5) * 9,
        0.3 + Math.random() * 0.2, 0.12, 0.02, 0.5, 0.85, 1, 1, 8);
    }
    this.add.emit(x, y, z, 0, 0, 0, 0.16, 0.5, 1.6, 0.45, 0.8, 1, 0.9);
  }

  stormWisp(x, y, z) {
    this.add.emit(x + (Math.random() - 0.5), y + Math.random() * 1.8, z + (Math.random() - 0.5), 0, 0.8, 0, 0.6, 0.25, 0.05, 0.8, 0.3, 1, 0.8);
  }

  /** Break a box volume into tumbling physics debris + dust. */
  shatter(mat, cx, cy, cz, hx, hy, hz, pushX = 0, pushY = 0, pushZ = 0, count = 7) {
    const fx = MAT_FX[mat] || MAT_FX.wood;
    const n = Math.round(count * this.scale());
    for (let i = 0; i < n; i++) {
      const x = cx + (Math.random() - 0.5) * hx * 1.6, y = cy + (Math.random() - 0.5) * hy * 1.6, z = cz + (Math.random() - 0.5) * hz * 1.6;
      const s = 0.25 + Math.random() * 0.45;
      this.debris.spawn(mat in this.debris.pools ? mat : 'wood', x, y, z, s * 1.6, s * 0.5, s,
        (x - cx) * 2 + pushX + (Math.random() - 0.5) * 3, 2 + Math.random() * 4 + pushY, (z - cz) * 2 + pushZ + (Math.random() - 0.5) * 3);
    }
    for (let i = 0; i < 5; i++) {
      this.alpha.emit(cx + (Math.random() - 0.5) * hx * 2, cy + (Math.random() - 0.5) * hy * 2, cz + (Math.random() - 0.5) * hz * 2,
        (Math.random() - 0.5) * 2, 0.5 + Math.random(), (Math.random() - 0.5) * 2, 1.2 + Math.random() * 0.6, 1.0, 2.6,
        fx.dust[0], fx.dust[1], fx.dust[2], 0.5, -0.2, 1.5, 0.3, 0.05);
    }
  }

  update(dt) {
    this.add.update(dt);
    this.alpha.update(dt);
    this.chips.update(dt);
    this.tracers.update(dt);
    this.debris.update(dt);
    this.syncLights();
    for (const L of this.lights) {
      if (L.peak <= 0) continue;
      L.t += dt;
      const k = Math.max(0, 1 - L.t / L.dur);
      L.light.intensity = L.peak * k * k;
      if (k <= 0) { L.peak = 0; L.light.intensity = 0; }
    }
  }

  clear() {
    this.decals.clear();
    this.debris.clear();
  }
}
