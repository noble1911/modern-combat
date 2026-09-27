// Writes public/icons/weapons/<id>.svg for every weapon picture in weapon_art.ts.
// Run with `npm run icons` (Node 24 runs this TypeScript directly).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ART, CROP, defs } from './weapon_art.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../public/icons/weapons');
mkdirSync(out, { recursive: true });
for (const [id, draw] of Object.entries(ART)) {
  const [vx, vy, vw, vh] = CROP[id] ?? [0, 0, 120, 36];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">${defs()}<g filter="url(#rim)">${draw()}</g></svg>\n`;
  writeFileSync(join(out, `${id}.svg`), svg);
}
console.log(`wrote ${Object.keys(ART).length} weapon icons to ${out}`);
