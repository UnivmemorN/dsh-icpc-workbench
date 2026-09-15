/**
 * Compatibility re-export of the bundled public Luogu platform-tag dictionary (Sprint 21a).
 *
 * The factual id → platform-name snapshot lives in the domain taxonomy layer
 * (`../domain/taxonomy/luogu-tag-dictionary.js`) so the pure source-tag crosswalk and every UI
 * surface read **one** table instead of two drifting copies. This module keeps the historical UI
 * import path (`./luogu-tag-dictionary.js`) working unchanged; it adds nothing and resolves nothing
 * itself, and the snapshot is still never fetched at runtime.
 */
export * from '../domain/taxonomy/luogu-tag-dictionary.js';
