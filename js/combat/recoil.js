// Camera recoil for the local player. Every shot kicks the aim up (and a little sideways) and the
// kick is remembered as an offset the camera pays back once the gun stops firing. Pulling against
// the kick settles that debt first, so recovery never drags the aim past where the player put it.
// Pure math (no three.js / DOM) so the node tests can drive it. Per-gun numbers live in WEAPONS.

export class Recoil {
  constructor() {
    this.reset();
  }

  reset() {
    this.p = 0;      // pitch the camera still owes back (rad, + = kicked up)
    this.y = 0;      // yaw still owed back (rad)
    this.since = 99; // s since the last shot
    this.w = null;   // spec of the gun that fired last: recovery keeps its rate after a switch
    this.dp = 0;     // pitch / yaw change from the last kick() or recover() call, for the caller to apply
    this.dy = 0;
  }

  /** One shot from gun w; mult scales it (ADS, crouch). */
  kick(w, mult, rnd = Math.random) {
    const v0 = (w.recoil || 0) * mult * (0.85 + 0.3 * rnd());
    // the climb flattens out as the offset nears the gun's cap (scaled like the kick, so ADS and
    // crouch lower the whole climb), so a long spray rises then levels instead of walking into the
    // sky; pulling down against it restores the full kick
    const v = v0 * Math.max(0.05, 1 - Math.max(0, this.p) / ((w.recoilMax || 1) * mult));
    // sideways: random, pulled back toward where the spray started (an SMG jitters left/right
    // around the target instead of wandering off it)
    const h = (w.recoilSide || 0) * mult * (rnd() * 2 - 1) - this.y * (w.recoilCenter || 0);
    this.p += v;
    this.y += h;
    this.since = 0;
    this.w = w;
    this.dp = v;
    this.dy = h;
  }

  /**
   * Player look movement this frame (rad). Moving against the kick (pulling down on a climbing
   * gun) is compensation: it pays off the owed offset, so recovery won't then drag the aim below
   * where the player held it. Moving with the kick leaves the debt alone, so recovery still
   * returns exactly the recoil and the player's own movement is kept.
   */
  look(dp, dy) {
    if (this.p * dp < 0) this.p = this.p > 0 ? Math.max(0, this.p + dp) : Math.min(0, this.p + dp);
    if (this.y * dy < 0) this.y = this.y > 0 ? Math.max(0, this.y + dy) : Math.min(0, this.y + dy);
  }

  /** Advance time; sets dp/dy to the camera change that pays back part of the offset. */
  recover(dt) {
    this.since += dt;
    this.dp = 0;
    this.dy = 0;
    const w = this.w;
    if (!w || (this.p === 0 && this.y === 0) || this.since < (w.recoverDelay || 0)) return;
    // exponential return (fast at first, then easing in) with a small linear floor so it lands
    const k = 1 - Math.exp(-(w.recover || 6) * dt);
    const floor = 0.004 * dt;
    const sp = step(this.p, k, floor), sy = step(this.y, k, floor);
    this.p -= sp;
    this.y -= sy;
    this.dp = -sp;
    this.dy = -sy;
  }
}

/** Part of offset x paid back this frame (same sign as x, never past zero). */
function step(x, k, floor) {
  const a = Math.abs(x);
  const d = Math.min(a, Math.max(a * k, floor));
  return x > 0 ? d : -d;
}
