// The Discover screen (pick a mode) and the custom mode creator. DOM only.

/**
 * Open the Discover sheet. Returns a handle with close(), or null when the screen is not
 * available (callers then show their own fallback list of MODES).
 * @param {object} app
 * @param {{ isLeader: boolean, current: object, onPick: (pick: { id: string } | { custom: object, name: string }) => void,
 *   onSuggest: (id: string) => void }} opts   current = the room settings
 * @returns {{ close: () => void } | null}
 */
export function openDiscover(app, opts) { return null; }

/**
 * Open the custom mode creator. Returns a handle with close(), or null when it is not available.
 * @param {object} app
 * @param {{ initial?: object, onPlay: (pick: { custom: object, name: string }) => void, onSave?: (mode: object) => void }} opts
 *   initial = rules to start from
 * @returns {{ close: () => void } | null}
 */
export function openCreator(app, opts) { return null; }
