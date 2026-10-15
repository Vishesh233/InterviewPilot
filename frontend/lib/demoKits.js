// The static demo kits (data/demo-kits.json, written by `npm run demo:snapshot`).
// Imported by the /demo server pages only, so a client page receives just the
// kit it renders and the demo never calls the API.
import snapshot from '@/data/demo-kits.json';

export const demoKits = Array.isArray(snapshot?.kits) ? snapshot.kits : [];

export const getDemoKit = (slug) => demoKits.find((kit) => kit.slug === slug) || null;
