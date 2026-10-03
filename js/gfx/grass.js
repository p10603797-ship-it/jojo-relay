import * as THREE from 'three';
import { SUN_DIR } from './sky.js';

/**
 * A field of instanced grass clumps that wraps around the camera (toroidally) so it
 * always surrounds the player at a fixed cost. Heights and grass coverage come from
 * the terrain info texture (R = height, G = grass weight).
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
    const h = 0.24 + r() * 0.26;
    const w = 0.05 + r() * 0.03;
    const lean = (r() - 0.3) * 0.25;
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

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uCam: { value: new THREE.Vector3() },
    uR: { value: R },
    uTime: { value: 0 },
    uTerrain: { value: null },
    uHalf: { value: half },
    uCell: { value: cell },
    uN: { value: n },
    uSun: { value: SUN_DIR },
    uRoot: { value: new THREE.Color(0x2b6a1d) },
    uTip: { value: new THREE.Color(0x7cc443) },
  }]);
  uniforms.uTerrain.value = terrainTex;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      uniform vec3 uCam;
      uniform float uR, uTime, uHalf, uCell, uN;
      uniform sampler2D uTerrain;
      attribute vec3 aOff;
      attribute float aH;
      varying float vH;
      varying float vShade;
      void main() {
        vec2 rel = mod(aOff.xy - uCam.xz + uR, 2.0 * uR) - uR;
        vec2 wp = uCam.xz + rel;
        vec2 tuv = ((wp + uHalf) / uCell + 0.5) / uN;
        vec4 ti = textureLod(uTerrain, tuv, 0.0);
        float fade = smoothstep(uR, uR * 0.72, length(rel));
        float s = ti.g * fade * (0.7 + aOff.z * 0.65) * step(1.0, ti.r);
        float a = aOff.z * 6.2831;
        float ca = cos(a), sa = sin(a);
        vec3 p = position * s;
        p.xz = vec2(p.x * ca - p.z * sa, p.x * sa + p.z * ca);
        float wave = sin(uTime * 1.7 + wp.x * 0.33 + wp.y * 0.21) + 0.45 * sin(uTime * 2.9 + wp.x * 0.9 - wp.y * 0.4);
        float bend = aH * aH * s;
        p.x += wave * 0.12 * bend;
        p.z += wave * 0.07 * bend;
        vec4 mvPosition = viewMatrix * vec4(wp.x + p.x, ti.r + p.y - 0.02, wp.y + p.z, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vH = aH;
        vShade = 0.85 + aOff.z * 0.3;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform vec3 uRoot, uTip, uSun;
      varying float vH;
      varying float vShade;
      void main() {
        vec3 albedo = mix(uRoot, uTip, vH) * vShade;
        float light = 0.55 + 0.95 * max(uSun.y, 0.0);
        vec3 col = albedo * light * 1.05;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'grass';
  mesh.userData.update = (camPos, time) => {
    uniforms.uCam.value.copy(camPos);
    uniforms.uTime.value = time;
  };
  return mesh;
}
