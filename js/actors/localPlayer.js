// The player on this device: turns input into look/move/actions, recoil, HUD sync.
import { WEAPONS, MAT_KEYS } from '../../shared/constants.js';
import { Combatant } from './combatant.js';
import { Recoil } from '../combat/recoil.js';

export class LocalPlayer extends Combatant {
  constructor(game, id, name, skin) {
    super(game, id, name, skin, false);
    this.isLocal = true;
    this.rc = new Recoil();
  }

  onInventory() {
    this.game.hud.inventory(this);
    this.game.hud.buildBar(this);
    this.game.input.setBuildMode(this.buildMode);
  }

  onFired(w) {
    // aiming down sights and crouching steady the gun
    const rc = this.rc;
    rc.kick(w, (this.ads ? 0.75 : 1) * (this.mover.crouch ? 0.8 : 1));
    const p0 = this.pitch;
    this.pitch = Math.min(Math.max(p0, 1.45), p0 + rc.dp);
    rc.p += this.pitch - p0 - rc.dp; // looking straight up: only owe back what was applied
    this.yaw += rc.dy;
    this.game.shake(w.shake ?? (w.pellets > 1 || w.projectile || w.scope ? 0.45 : 0.12));
  }

  respawn(x, y, z) {
    super.respawn(x, y, z);
    this.rc.reset();
  }

  /** Look + inventory/build mode handling from the input state. */
  control(dt, s) {
    const cur = this.current();
    const w = cur && WEAPONS[cur.k];
    const zoom = this.ads && w && w.zoom ? w.zoom : 1;
    const k = 1 / Math.pow(zoom, 0.8);
    const p0 = this.pitch;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + s.lookY * k));
    // the player's own aim first settles recoil they pulled against; then the camera drifts back
    // toward where it was before the gun kicked
    const rc = this.rc;
    rc.look(this.pitch - p0, s.lookX * k);
    rc.recover(dt);
    this.yaw += s.lookX * k + rc.dy;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + rc.dp));
    if (!this.canAct()) return;

    let changed = false;
    if (s.emote && this.mover.grounded) { this.dancing = !this.dancing; this.buildMode = false; changed = true; }
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
