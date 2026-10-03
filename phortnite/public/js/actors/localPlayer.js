// The player on this device: turns input into look/move/actions, recoil, HUD sync.
import { WEAPONS, MAT_KEYS } from '../../shared/constants.js';
import { Combatant } from './combatant.js';

export class LocalPlayer extends Combatant {
  constructor(game, id, name, skin) {
    super(game, id, name, skin, false);
    this.isLocal = true;
  }

  onInventory() {
    this.game.hud.inventory(this);
    this.game.hud.buildBar(this);
    this.game.input.setBuildMode(this.buildMode);
  }

  onFired(w) {
    const k = w.recoil * (this.ads ? 0.7 : 1) * (this.mover.crouch ? 0.8 : 1);
    this.pitch = Math.min(1.45, this.pitch + k * (0.85 + Math.random() * 0.3));
    this.yaw += (Math.random() - 0.5) * k * 0.7;
    this.game.shake(w.pellets > 1 || w.projectile || w.scope ? 0.45 : 0.12);
  }

  /** Look + inventory/build mode handling from the input state. */
  control(dt, s) {
    const cur = this.current();
    const w = cur && WEAPONS[cur.k];
    const zoom = this.ads && w && w.zoom ? w.zoom : 1;
    const k = 1 / Math.pow(zoom, 0.8);
    this.yaw += s.lookX * k;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + s.lookY * k));
    if (!this.canAct()) return;

    let changed = false;
    if (s.slot >= 0 && (s.slot === 0 || this.inv.slots[s.slot])) { this.select(s.slot); changed = true; }
    if (s.scroll) { this.cycle(s.scroll > 0 ? 1 : -1); changed = true; }
    if (s.buildToggle) {
      this.buildMode = !this.buildMode;
      this.reloadT = -1;
      this.healT = -1;
      changed = true;
    }
    if (s.build) {
      this.buildMode = true;
      this.buildType = s.build;
      this.reloadT = -1;
      this.healT = -1;
      changed = true;
    }
    if (s.matCycle || (this.buildMode && s.adsPressed)) {
      const i = MAT_KEYS.indexOf(this.buildMat);
      this.buildMat = MAT_KEYS[(i + 1) % MAT_KEYS.length];
      changed = true;
    }
    if (changed) this.onInventory();
  }
}
