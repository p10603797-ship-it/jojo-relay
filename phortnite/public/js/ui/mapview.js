// Minimap (#minimap) and full map (#fullmap): the island picture from world.mapCanvas with the
// storm, the bus route, teammates and you on top. Hud.drawMap / minimap / toggleFullMap forward here.
//
// extras (from Game.updateHud): { bus, busPos, dots: [{x,z,c}], names, layers }
//   layers = game.mapExtras: one entry per feature that wants something on the map, e.g.
//   game.mapExtras.koth = { dots: [{x,z,c}], rings: [{x,z,r,c}], pins: [{x,z,c,label}] }
export class MapView {
  constructor(hud, world) {
    this.hud = hud;
    this.world = world;
    this.el = hud.el;
    this.mapCtx = this.el.map.getContext('2d');
    this.mapT = 0;
    this.el.map.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.toggleFullMap(); });
    this.el.fullmap.addEventListener('pointerdown', () => this.toggleFullMap(false));
  }

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
        ctx.beginPath();
        ctx.arc(toX(extras.busPos.x), toY(extras.busPos.z), 6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (extras.names) {
      ctx.font = `${Math.max(11, size / 50)}px "Luckiest Guy", sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = '#fff';
      for (const p of d.pois) {
        ctx.strokeText(p.name.toUpperCase(), toX(p.x), toY(p.z));
        ctx.fillText(p.name.toUpperCase(), toX(p.x), toY(p.z));
      }
    }
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
          ctx.arc(toX(dot.x), toY(dot.z), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (L.pins) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const p of L.pins) {
          const x = toX(p.x), y = toY(p.z);
          ctx.fillStyle = p.c || '#ffd23f';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y - 9);
          ctx.lineTo(x + 5, y - 9);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          if (p.label) {
            ctx.lineWidth = 3;
            ctx.strokeText(p.label, x, y - 12);
            ctx.fillText(p.label, x, y - 12);
          }
        }
      }
    }
  }

  minimap(dt, me, storm, extras) {
    this.mapT -= dt;
    if (this.mapT > 0) return;
    this.mapT = 1 / 15;
    const c = this.el.map;
    this.drawMap(this.mapCtx, c.width, me.x, me.z, 230, me, storm, extras);
    if (!this.el.fullmap.classList.contains('hidden')) {
      const fc = this.el.fullmap.querySelector('canvas');
      this.drawMap(fc.getContext('2d'), fc.width, 0, 0, this.world.data.size, me, storm, { ...extras, names: true });
    }
  }

  toggleFullMap(on) {
    const fm = this.el.fullmap;
    const show = on ?? fm.classList.contains('hidden');
    fm.classList.toggle('hidden', !show);
  }
}
