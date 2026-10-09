// Roster rows as the room sends them, with clean types (no three.js here: game plugins that load in
// Node use it too).
import { SKINS } from '../../shared/constants.js';

/**
 * A roster row from the room with clean types. In a P2P party the Room runs on the host's page, so
 * whatever the host sends is untrusted: every reader (the lobby cards, the stage, the HUD) gets
 * numbers that are numbers and strings that are short.
 */
export function cleanRow(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...src, id: src.id | 0 };
  if ('name' in src) out.name = String(src.name ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 24) || 'Player';
  if ('skin' in src) out.skin = Math.max(0, Math.min(SKINS.length - 1, src.skin | 0));
  if ('lvl' in src) out.lvl = Math.max(1, Math.min(999, src.lvl | 0));
  if ('kills' in src) out.kills = Math.max(0, src.kills | 0);
  if ('team' in src) out.team = Number.isFinite(src.team) ? src.team : out.id;
  if ('skill' in src) out.skill = Number.isFinite(src.skill) ? src.skill : 0.5;
  for (const k of ['bot', 'alive', 'ready', 'spec']) if (k in src) out[k] = !!src[k];
  if ('away' in src) out.away = src.away ? 1 : 0;
  return out;
}
