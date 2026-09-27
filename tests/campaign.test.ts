import { expect, it } from 'vitest';
import { aiOrders, autoResolve, bgStrength, endTurn, newCampaign, turnLabel } from '../src/game/campaign';
import { createBattle } from '../src/game/scenario';

it('plays a full automated operation', async () => {
  const st = newCampaign('nato', Number(process.env.SEED ?? 42));
  let guard = 0;
  while (!st.over && guard++ < 20) {
    for (const b of st.battles) {
      if (b.resolved) continue;
      await autoResolve(st, b, (s) => createBattle(s));
    }
    aiOrders(st, 'nato');
    const status = st.sectors.map((s) => `${s.mapId.slice(0, 4)}:${s.owner[0]}${s.bridgeBlown ? '!' : ''}`).join(' ');
    const bgs = st.bgs.filter((b) => !b.destroyed && b.arrives <= st.turn).map((b) => `${b.id}@${b.sector}:${Math.round(bgStrength(b) * 100)}%:${b.order}`).join(' ');
    console.log(`${turnLabel(st.turn)} | ${status} | ${bgs}`);
    endTurn(st);
  }
  for (const l of st.log) console.log(`  [${turnLabel(l.turn)}] ${l.text}`);
  console.log('OVER', st.over);
  expect(st.over).not.toBeNull();
}, 900000);
