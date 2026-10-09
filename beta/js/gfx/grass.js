import * as THREE from 'three';
import { SUN_DIR } from './sky.js';
import { BIOMES } from '../../shared/world/keys.js';

/** Blade colours (root, tip) and height per grass tint id: one per biome (BIOMES order), then wheat. */
const TINTS = {
  ocean: [0x2a6820, 0x76bf48, 1], beach: [0x6f8a3a, 0xc9c77a, 0.8], meadow: [0x2a6820, 0x76bf48, 1], forest: [0x1d5220, 0x4c963a, 0.9],
  farm: [0x4a6e22, 0xa4c050, 1], city: [0x2e6a26, 0x6fb24a, 0.8], snow: [0x5d7a62, 0xb8cfc0, 0.7], desert: [0x7a7238, 0xc7b46a, 0.8],
  mesa: [0x7a6a38, 0xc0a060, 0.8], jungle: [0x165a1c, 0x50b03a, 1.0], swamp: [0x3d5222, 0x8a9a4a, 1.0], volcano: [0x3a3a2a, 0x6a6a40, 0.7],
  wheat: [0x9a7a2a, 0xf0d070, 1.9],
};

/**
 * A field of instanced grass clumps that wraps around the camera (toroidally) so it always
 * surrounds the player at a fixed cost. The terrain info texture gives the ground height (R),
 * how much grass grows (G) and the tint (A: the biome, or wheat). Blades are lit by the ground's
 * normal and darkened in shadow; near the edge of the patch they shrink and thin out, so there
 * is no ring.
 */
export function createGrass(terrainTex, half, cell, n, side = 96, spacing = 0.5) {
  const BL = 6;
  const pos = [], aH = [];
  const idx = [];
  let rnd = 12345;
  const r = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < BL; b++) {
    const ox = (r() - 0.5) * 0.4, oz = (r() - 0.5) * 0.4;
    const ang = r() * Math.PI * 2;
    const h = 0.15 + r() * 0.2;
    const w = 0.035 + r() * 0.025;
    const lean = (r() - 0.3) * 0.2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const base = pos.length / 3;
    const verts = [[-w, 0, 0], [w, 0, 0], [-w * 0.55, 0.5, lean * 0.3], [w * 0.55, 0.5, lean * 0.3], [0, 1, lean]];
    for (const [vx, vy, vz] of verts) {
      const x = vx * ca - vz * sa, z = vx * sa + vz * ca;
      pos.push(ox + x, vy * h, oz + z);
      aH.push(vy);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 1));
  geo.setIndex(idx);
  const count = side * side;
  const offs = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const gx = i % side, gz = Math.floor(i / side);
    offs[i * 3] = (gx + r() * 0.9) * spacing;
    offs[i * 3 + 1] = (gz + r() * 0.9) * spacing;
    offs[i * 3 + 2] = r();
  }
  geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(offs, 3));
  geo.instanceCount = count;
  const R = side * spacing / 2;

  const keys = [...BIOMES, 'wheat'];
  const root = keys.map((k) => new THREE.Color((TINTS[k] || TINTS.meadow)[0]));
  const tip = keys.map((k) => new THREE.Color((TINTS[k] || TINTS.meadow)[1]));
  const tall = keys.map((k) => (TINTS[k] || TINTS.meadow)[2]);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, THREE.UniformsLib.lights, {
    uCam: { value: new THREE.Vector3() },
    uR: { value: R },
    uTime: { value: 0 },
    uTerrain: { value: null },
    uHalf: { value: half },
    uCell: { value: cell },
    uN: { value: n },
    uSun: { value: SUN_DIR },
    uSea: { value: 0 },
  }]);
  uniforms.uTerrain.value = terrainTex;
  uniforms.uRoot = { value: root };
  uniforms.uTip = { value: tip };
  uniforms.uTall = { value: tall };
  const NT = keys.length;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    lights: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      #include <shadowmap_pars_vertex>
      uniform vec3 uCam, uSun, uRoot[${NT}], uTip[${NT}];
      uniform float uR, uTime, uHalf, uCell, uN, uSea, uTall[${NT}];
      uniform sampler2D uTerrain;
      attribute vec3 aOff;
      attribute float aH;
      varying float vH;
      varying vec3 vCol;
      varying float vLight;
      void main() {
        vec2 rel = mod(aOff.xy - uCam.xz + uR, 2.0 * uR) - uR;
        vec2 wp = uCam.xz + rel;
        vec2 tuv = ((wp + uHalf) / uCell + 0.5) / uN;
        vec4 ti = textureLod(uTerrain, tuv, 0.0);
        // the ground's normal from the height next door
        float du = 1.0 / uN;
        float hx = textureLod(uTerrain, tuv + vec2(du, 0.0), 0.0).r - textureLod(uTerrain, tuv - vec2(du, 0.0), 0.0).r;
        float hz = textureLod(uTerrain, tuv + vec2(0.0, du), 0.0).r - textureLod(uTerrain, tuv - vec2(0.0, du), 0.0).r;
        vec3 gn = normalize(vec3(-hx, 2.0 * uCell, -hz));
        // fade out toward the edge of the patch: shorter and sparser, no visible ring
        float d = length(rel) / uR;
        float edge = 1.0 - smoothstep(0.55, 1.0, d);
        float keep = step(aOff.z * 0.85, edge);
        int tid = int(clamp(floor(ti.a + 0.5), 0.0, ${(NT - 1).toFixed(1)}));
        float s = ti.g * keep * (0.35 + 0.65 * edge) * (0.7 + aOff.z * 0.65) * step(uSea + 0.35, ti.r) * uTall[tid];
        float a = aOff.z * 6.2831;
        float ca = cos(a), sa = sin(a);
        vec3 p = position * s;
        p.xz = vec2(p.x * ca - p.z * sa, p.x * sa + p.z * ca);
        float wave = sin(uTime * 1.7 + wp.x * 0.33 + wp.y * 0.21) + 0.45 * sin(uTime * 2.9 + wp.x * 0.9 - wp.y * 0.4);
        float bend = aH * aH * s;
        p.x += wave * 0.12 * bend;
        p.z += wave * 0.07 * bend;
        vec4 worldPosition = vec4(wp.x + p.x, ti.r + p.y - 0.02, wp.y + p.z, 1.0);
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        vec3 transformedNormal = (viewMatrix * vec4(gn, 0.0)).xyz;
        #include <shadowmap_vertex>
        vH = aH;
        vCol = mix(uRoot[tid], uTip[tid], aH) * (0.85 + aOff.z * 0.3);
        vLight = max(dot(gn, uSun), 0.0);
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      #include <bsdfs>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      varying float vH;
      varying vec3 vCol;
      varying float vLight;
      void main() {
        float sh = getShadowMask();
        // ambient sky light, plus the sun where it reaches (lit by the ground's slope)
        float light = 0.42 + 0.95 * vLight * mix(0.25, 1.0, sh);
        vec3 col = vCol * light * mix(0.8, 1.05, vH);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.name = 'grass';
  mesh.userData.update = (camPos, time) => {
    uniforms.uCam.value.copy(camPos);
    uniforms.uTime.value = time;
  };
  mesh.userData.setSea = (y) => { uniforms.uSea.value = y; };
  return mesh;
}
