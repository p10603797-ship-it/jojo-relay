// Minimap (#minimap) and full map (#fullmap): the island picture (world.mapCanvas, painted by
// paintMapArt from the world's grids) with the storm, the bus route, places, markers, teammates
// and you on top. Hud.drawMap / minimap / toggleFullMap forward here.
//
// extras (from Game.updateHud): { bus, busPos, dots: [{x,z,c}], names, layers }
//   layers = game.mapExtras: one entry per feature that wants something on the map, e.g.
//   game.mapExtras.koth = { dots: [{x,z,c,r?}], rings: [{x,z,r,c}], pins: [{x,z,c,label,big?}] }
//
// The full map pinch-zooms 1-4x and pans (mouse wheel / drag on desktop); a tap drops your marker
// (or clears it when you tap it again): MapView.onMark(x, z) / onMark(null), which MapClient sends.
import { BIOMES, SURFACES } from '../../shared/world/keys.js';

const ART = 1024;
const SURF_RGB = {
  grass: [104, 168, 74], dirt: [154, 118, 80], sand: [226, 208, 150], rock: [140, 138, 132], snow: [240, 245, 250], ice: [205, 230, 245],
  redsand: [208, 138, 90], strata: [176, 102, 74], mud: [107, 92, 58], junglefloor: [63, 122, 50], ash: [74, 70, 68], lava: [255, 96, 30],
  asphalt: [92, 94, 98], cobble: [154, 149, 140], field: [160, 140, 80], wheat: [224, 192, 96], asphaltLines: [92, 94, 98],
};
const BIOME_SHIFT = { forest: [0.82, 0.9, 0.8], jungle: [0.78, 0.98, 0.72], swamp: [0.82, 0.86, 0.7], farm: [1.05, 1.0, 0.85], meadow: [1.0, 1.03, 0.95] };
const ROOFS = ['#a53c2b', '#3e5574', '#6c4a32', '#4b6f3d'];
const TIER_STYLE = {
  hot: { size: 1.3, fill: '#ffd23f' },
  normal: { size: 1.0, fill: '#ffffff' },
  quiet: { size: 0.82, fill: '#e6eef5' },
};

/**
 * The island picture: biome and surface colours, hillshade, water depth, roads, building
 * footprints and lava, about 1.6 m a pixel (512-1024 px; names are drawn live, so they stay sharp).
 * mapArtJob(world) paints it a slice of rows at a time: job.step(rows) returns true when done,
 * job.finish() completes it at once; job.canvas is the picture.
 */
export function mapArtJob(world) {
  const d = world.data;
  const S = Math.max(512, Math.min(ART, 1 << Math.round(Math.log2(d.size / 1.6))));
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const { N, cell, half, heights } = d;
  const H = (ix, iz) => heights[(iz < 0 ? 0 : iz >= N ? N - 1 : iz) * N + (ix < 0 ? 0 : ix >= N ? N - 1 : ix)];
  const surf = world.terrain ? world.terrain.surf : null;
  const keys = (world.terrain && world.terrain.layerKeys) || SURFACES;
  const biome = d.biome;
  const sea = 0;
  let row = 0;
  const rows = (y0, y1) => {
    for (let py = y0; py < y1; py++) {
      const z = -half + ((py + 0.5) / S) * d.size;
      const fz = (z + half) / cell;
      const iz = Math.floor(fz), tz = fz - iz;
      for (let px = 0; px < S; px++) {
        const x = -half + ((px + 0.5) / S) * d.size;
        const fx = (x + half) / cell;
        const ix = Math.floor(fx), tx = fx - ix;
        const h = (H(ix, iz) * (1 - tx) + H(ix + 1, iz) * tx) * (1 - tz) + (H(ix, iz + 1) * (1 - tx) + H(ix + 1, iz + 1) * tx) * tz;
        let r, gg, b;
        if (h < sea) {
          const t = Math.min(1, (sea - h) / 12);
          r = 70 - 44 * t; gg = 196 - 92 * t; b = 214 - 40 * t;
        } else {
          const gi = Math.min(N - 1, Math.round(fz)) * N + Math.min(N - 1, Math.round(fx));
          const key = surf ? keys[surf[gi]] : 'grass';
          const base = SURF_RGB[key] || SURF_RGB.grass;
          r = base[0]; gg = base[1]; b = base[2];
          if (biome && (key === 'grass' || key === 'junglefloor')) {
            const sh = BIOME_SHIFT[BIOMES[biome[gi]]];
            if (sh) { r *= sh[0]; gg *= sh[1]; b *= sh[2]; }
          }
          // hillshade (light from the north-west) and a little brightening with height
          const slope = (H(ix - 1, iz - 1) - H(ix + 1, iz + 1)) / cell;
          const lit = Math.max(0.55, Math.min(1.35, 1 + slope * 0.32));
          const shade = (0.9 + Math.min(0.25, h / 400)) * lit;
          r *= shade; gg *= shade; b *= shade;
          // shoreline
          if (h < sea + 0.6) { r = r * 0.8 + 236 * 0.2; gg = gg * 0.8 + 226 * 0.2; b = b * 0.8 + 180 * 0.2; }
        }
        const i = (py * S + px) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
  };
  const overlays = () => {
    g.putImageData(img, 0, 0);
    const k = S / d.size;
    const X = (x) => (x + half) * k, Z = (z) => (z + half) * k;
    // lava pools
    for (const l of d.lava || []) {
      g.fillStyle = '#ff6a1a';
      g.beginPath();
      g.arc(X(l.x), Z(l.z), Math.max(2, l.r * k), 0, Math.PI * 2);
      g.fill();
    }
    // roads: a dark casing, then the road
    const roadList = d.roads || [];
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const rd of roadList) {
        if (!rd.pts || rd.pts.length < 2) continue;
        const w = Math.max(1.6, (rd.w || 6) * k);
        g.lineWidth = pass ? w : w + 2;
        g.strokeStyle = pass ? (rd.kind === 'dirt' ? '#c4a57a' : '#e9e4d6') : 'rgba(40, 36, 30, 0.55)';
        g.beginPath();
        g.moveTo(X(rd.pts[0][0]), Z(rd.pts[0][1]));
        for (let i = 1; i < rd.pts.length; i++) g.lineTo(X(rd.pts[i][0]), Z(rd.pts[i][1]));
        g.stroke();
      }
    }
    // building footprints
    for (const hs of d.houses) {
      const b = hs.bounds || [hs.x - hs.hx, hs.z - hs.hz, hs.x + hs.hx, hs.z + hs.hz];
      const city = hs.archetype === 'skyscraper' || hs.archetype === 'apartment' || hs.archetype === 'mall' || hs.archetype === 'warehouse' || hs.archetype === 'stadium';
      g.fillStyle = city ? '#cfcac0' : hs.roof === 'gable' || !hs.archetype || hs.archetype === 'house' ? ROOFS[(hs.paint | 0) % 4] : '#bdb4a4';
      if (hs.archetype === 'bridge' || hs.archetype === 'pier') g.fillStyle = '#a0784a';
      g.fillRect(X(b[0]), Z(b[1]), Math.max(1.5, (b[2] - b[0]) * k), Math.max(1.5, (b[3] - b[1]) * k));
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 1;
      g.strokeRect(X(b[0]), Z(b[1]), Math.max(1.5, (b[2] - b[0]) * k), Math.max(1.5, (b[3] - b[1]) * k));
    }
  };
  let done = false;
  const job = {
    canvas: c,
    /** Paint up to n more rows; true when the picture is finished. */
    step(n = 48) {
      if (done) return true;
      const y1 = Math.min(S, row + n);
      rows(row, y1);
      row = y1;
      if (row >= S) { overlays(); done = true; }
      return done;
    },
    finish() { while (!job.step(S)); return c; },
    get done() { return done; },
  };
  return job;
}

/** The whole island picture at once (see mapArtJob). */
export function paintMapArt(world) {
  return mapArtJob(world).finish();
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class MapView {
  constructor(hud, world) {
    this.hud = hud;
    this.world = world;
    this.el = hud.el;
    this.mapCtx = this.el.map.getContext('2d');
    this.mapT = 0;
    this.skydive = false;     // set by MapClient: a bigger minimap while skydiving / in the bus
    this.onMark = null;       // set by MapClient: (x, z) to drop your marker, null to clear it
    this.myMark = null;       // { x, z } (MapClient keeps it current)
    this.fm = { zoom: 1, cx: 0, cz: 0 };
    this.el.map.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleFullMap(); });
    this.setupFullMap();
  }

  // ------------------------------------------------------------------ full map gestures
  setupFullMap() {
    const fm = this.el.fullmap;
    if (!fm) return;
    const canvas = fm.querySelector('canvas');
    this.fmCanvas = canvas;
    // tapping the dark backdrop (outside the map) or the close button closes it
    fm.addEventListener('pointerdown', (e) => { if (e.target === fm) this.toggleFullMap(false); });
    const close = document.createElement('button');
    close.className = 'fm-x';
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close map');
    close.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleFullMap(false); });
    fm.appendChild(close);
    const hint = fm.querySelector('.fm-close');
    if (hint) hint.textContent = 'Tap to drop a marker · pinch to zoom · M to close';
    const zoom = document.createElement('div');
    zoom.className = 'fm-zoom';
    zoom.innerHTML = '<button type="button" data-z="1">+</button><button type="button" data-z="-1">−</button>';
    zoom.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (b) this.zoomAt(this.fm.zoom * (b.dataset.z === '1' ? 1.5 : 1 / 1.5), null);
    });
    fm.appendChild(zoom);
    if (!canvas) return;
    const ptrs = new Map();
    let pinch = null, tap = null;
    const local = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (er) { /* fine */ }
      ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) tap = { ...local(e), moved: 0, t: performance.now(), cx: this.fm.cx, cz: this.fm.cz };
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 0.01, zoom: this.fm.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        tap = null;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const p = local(e);
      ptrs.set(e.pointerId, p);
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 0.01;
        this.zoomAt(pinch.zoom * (d / pinch.d), pinch.mid);
      } else if (tap) {
        const dx = p.x - tap.x, dy = p.y - tap.y;
        tap.moved = Math.max(tap.moved, Math.hypot(dx, dy));
        if (tap.moved > 0.012 && this.fm.zoom > 1.01) {
          const span = this.world.data.size / this.fm.zoom;
          this.fm.cx = tap.cx - dx * span;
          this.fm.cz = tap.cz - dy * span;
          this.clampView();
          this.redrawFull();
        }
      }
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (tap && ptrs.size === 0) {
        if (tap.moved < 0.012 && performance.now() - tap.t < 1200) this.tapAt(tap.x, tap.y);
        tap = null;
      }
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(this.fm.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), local(e));
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Map point under a canvas position (0..1). */
  viewToWorld(u, v) {
    const span = this.world.data.size / this.fm.zoom;
    return { x: this.fm.cx + (u - 0.5) * span, z: this.fm.cz + (v - 0.5) * span };
  }

  zoomAt(z, at) {
    const before = at ? this.viewToWorld(at.x, at.y) : null;
    this.fm.zoom = clamp(z, 1, 4);
    if (before) {
      const after = this.viewToWorld(at.x, at.y);
      this.fm.cx += before.x - after.x;
      this.fm.cz += before.z - after.z;
    }
    this.clampView();
    this.redrawFull();
  }

  clampView() {
    const half = this.world.data.size / 2, span = this.world.data.size / this.fm.zoom;
    const lim = Math.max(0, half - span / 2);
    this.fm.cx = clamp(this.fm.cx, -lim, lim);
    this.fm.cz = clamp(this.fm.cz, -lim, lim);
  }

  tapAt(u, v) {
    if (!this.onMark) return;
    const p = this.viewToWorld(u, v);
    const span = this.world.data.size / this.fm.zoom;
    const m = this.myMark;
    // tapping your own marker again clears it
    if (m && Math.hypot(m.x - p.x, m.z - p.z) < span * 0.03) this.onMark(null);
    else this.onMark(p.x, p.z);
    this.redrawFull();
  }

  redrawFull() {
    if (this.last && !this.el.fullmap.classList.contains('hidden')) this.drawFull(this.last.me, this.last.storm, this.last.extras);
  }

  // ------------------------------------------------------------------ drawing
  drawMap(ctx, size, cx, cz, span, me, storm, extras) {
    const world = this.world;
    const d = world.data;
    const src = world.mapCanvas;
    const k = src.width / d.size;          // map px per metre
    const s = size / span;                 // screen px per metre
    ctx.save();
    ctx.fillStyle = '#2a6f9f';
    ctx.fillRect(0, 0, size, size);
    const sx = (cx - span / 2 + d.half) * k, sy = (cz - span / 2 + d.half) * k;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, sx, sy, span * k, span * k, 0, 0, size, size);
    const toX = (x) => (x - cx) * s + size / 2, toY = (z) => (z - cz) * s + size / 2;
    if (storm) {
      ctx.fillStyle = 'rgba(120, 40, 220, 0.4)';
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.arc(toX(storm.cx), toY(storm.cz), storm.r * s, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(toX(storm.ncx), toY(storm.ncz), storm.nr * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (extras.bus) {
      const b = extras.bus;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(toX(b.ax), toY(b.az));
      ctx.lineTo(toX(b.bx), toY(b.bz));
      ctx.stroke();
      ctx.setLineDash([]);
      if (extras.busPos) {
        ctx.fillStyle = '#2f8cff';
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(toX(extras.busPos.x), toY(extras.busPos.z), 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (extras.pads) this.drawPads(ctx, toX, toY, size);
    if (extras.names) this.drawNames(ctx, toX, toY, size, extras.names === 'small' ? 0.8 : 1, span);
    if (extras.layers) this.drawLayers(ctx, extras.layers, toX, toY, s);
    if (extras.dots) {
      for (const dot of extras.dots) {
        ctx.fillStyle = dot.c;
        ctx.beginPath();
        ctx.arc(toX(dot.x), toY(dot.z), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (me) {
      ctx.translate(toX(me.x), toY(me.z));
      ctx.rotate(-me.yaw);
      ctx.fillStyle = '#ffd23f';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 3);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Place names: bigger and gold for hot places; landmarks only when zoomed in. */
  drawNames(ctx, toX, toY, size, scale, span) {
    const d = this.world.data;
    const regs = d.regions || d.pois || [];
    const base = Math.max(11, size / 52) * scale;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // names that would run into a name already drawn are left out (hot places first, landmarks
    // last); zooming in makes room for more
    const RANK = { hot: 0, normal: 1, quiet: 2 };
    const order = regs.slice().sort((a, b) => (a.named === false) - (b.named === false) || (RANK[a.tier] ?? 1) - (RANK[b.tier] ?? 1));
    const drawn = [];
    for (const r of order) {
      const named = r.named !== false;
      if (!named && span > d.size * 0.45) continue;
      const x = toX(r.x), y = toY(r.z);
      if (x < -60 || y < -20 || x > size + 60 || y > size + 20) continue;
      const st = TIER_STYLE[r.tier] || TIER_STYLE.normal;
      const fs = Math.round(base * (named ? st.size : 0.72));
      ctx.font = `${fs}px "Luckiest Guy", "Russo One", sans-serif`;
      const text = named ? r.name.toUpperCase() : r.name;
      const w = ctx.measureText(text).width;
      const box = [x - w / 2 - 3, y - fs * 0.6, x + w / 2 + 3, y + fs * 0.6];
      if (drawn.some((b) => b[0] < box[2] && box[0] < b[2] && b[1] < box[3] && box[1] < b[3])) continue;
      drawn.push(box);
      ctx.lineWidth = Math.max(3, fs * 0.22);
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.fillStyle = named ? st.fill : '#d8e6f0';
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  drawPads(ctx, toX, toY, size) {
    const pads = this.world.traversal ? this.world.traversal.pads : [];
    for (const p of pads) {
      const x = toX(p.x), y = toY(p.z);
      if (x < -5 || y < -5 || x > size + 5 || y > size + 5) continue;
      ctx.fillStyle = p.kind === 'launch' ? '#4fd2ff' : p.kind === 'geyser' ? '#ffffff' : '#ff6aa0';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (p.kind === 'launch') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3.5); ctx.lineTo(x - 4.5, y + 3.5); ctx.closePath(); } else ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** game.mapExtras: rings (areas), pins (markers with a label) and dots from game features. */
  drawLayers(ctx, layers, toX, toY, s) {
    for (const key in layers) {
      const L = layers[key];
      if (!L) continue;
      if (L.rings) {
        ctx.lineWidth = 2;
        for (const r of L.rings) {
          ctx.strokeStyle = r.c || '#fff';
          ctx.beginPath();
          ctx.arc(toX(r.x), toY(r.z), Math.max(2, r.r * s), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (L.dots) {
        for (const dot of L.dots) {
          ctx.fillStyle = dot.c || '#fff';
          ctx.beginPath();
          ctx.arc(toX(dot.x), toY(dot.z), dot.r || 3, 0, Math.PI * 2);
          ctx.fill();
          if (dot.r) { ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke(); }
        }
      }
      if (L.pins) {
        ctx.textAlign = 'center';
        for (const p of L.pins) {
          const x = toX(p.x), y = toY(p.z);
          const big = p.big ? 1.7 : 1;
          ctx.fillStyle = p.c || '#ffd23f';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5 * big, y - 9 * big);
          ctx.lineTo(x + 5 * big, y - 9 * big);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          if (p.big) {
            ctx.beginPath();
            ctx.arc(x, y - 12 * big, 6 * big, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
          if (p.label) {
            ctx.font = p.big ? `${Math.round(15 * big)}px "Luckiest Guy", "Russo One", sans-serif` : '12px system-ui, sans-serif';
            ctx.lineWidth = 3;
            ctx.strokeText(p.label, x, y - (p.big ? 24 * big : 12));
            ctx.fillText(p.label, x, y - (p.big ? 24 * big : 12));
          }
        }
      }
    }
  }

  /** The minimap's span: about 1/7 of the island (230-500 m), 1.6x while skydiving. */
  span() {
    const size = this.world.data.size;
    return clamp(size / 7, 230, 500) * (this.skydive ? 1.6 : 1);
  }

  minimap(dt, me, storm, extras) {
    this.mapT -= dt;
    if (this.mapT > 0) return;
    this.mapT = 1 / 15;
    const c = this.el.map;
    this.last = { me, storm, extras };
    // ease the span when the skydive zoom changes
    const want = this.span();
    this.curSpan = this.curSpan ? this.curSpan + (want - this.curSpan) * 0.25 : want;
    this.drawMap(this.mapCtx, c.width, me.x, me.z, this.curSpan, me, storm, this.skydive ? { ...extras, names: 'small' } : extras);
    if (!this.el.fullmap.classList.contains('hidden')) this.drawFull(me, storm, extras);
  }

  drawFull(me, storm, extras) {
    const fc = this.fmCanvas || this.el.fullmap.querySelector('canvas');
    if (!fc) return;
    const span = this.world.data.size / this.fm.zoom;
    this.drawMap(fc.getContext('2d'), fc.width, this.fm.cx, this.fm.cz, span, me, storm, { ...extras, names: true, pads: true });
  }

  toggleFullMap(on) {
    const fm = this.el.fullmap;
    const show = on ?? fm.classList.contains('hidden');
    fm.classList.toggle('hidden', !show);
    document.body.classList.toggle('fullmap-open', show);
    if (show) {
      this.fm.zoom = 1; this.fm.cx = 0; this.fm.cz = 0;
      this.redrawFull();
    }
  }
}
