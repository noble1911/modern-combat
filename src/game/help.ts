export function helpHtml(): string {
  return `<h1>Field Manual</h1>
<div class="lead">Modern Combat is a real-time tactical wargame. You command a company-sized battlegroup of individually simulated soldiers and vehicles.
Your soldiers are people, not robots: under fire they get <b>suppressed</b>, <b>pinned</b>, may <b>panic</b>, <b>rout</b> or even <b>surrender</b>. Winning means keeping your men functional while breaking the enemy's will to fight.</div>

<h2>Controls</h2>
<table>
<tr><td><b>Left-click</b></td><td>Select a unit (shift-click to add). Drag a box to select several.</td></tr>
<tr><td><b>Right-click</b></td><td>Open the order menu at that spot. Right-click an enemy for fire/strike orders, a friendly carrier to mount up.</td></tr>
<tr><td><b>W A S D / arrows</b></td><td>Pan the camera (or push the mouse to the screen edge).</td></tr>
<tr><td><b>Q / E</b>, middle-drag</td><td>Rotate / tilt the camera. <b>Wheel</b> zooms. Shift + middle-drag pans.</td></tr>
<tr><td><b>Space</b></td><td>Pause (you can still give orders). <b>1–4</b>: pause / 1× / 2× / 4× speed.</td></tr>
<tr><td><b>L</b></td><td>Line-of-sight tool: shows what the selected unit can see and hit.</td></tr>
<tr><td><b>Tab</b></td><td>Cycle through your units. <b>Ctrl+digit</b> assigns a group, <b>digit</b> recalls it.</td></tr>
<tr><td><b>Esc</b></td><td>Cancel / deselect / pause menu.</td></tr>
</table>

<h2>Orders</h2>
<table>
<tr><td><b>Move</b> (M)</td><td>Walk to the destination. Soldiers spread out into the best cover they can find when they arrive. They return fire on the way.</td></tr>
<tr><td><b>Move Fast</b> (R)</td><td>Run. Faster, but tiring, and runners don't stop to shoot. Use it to cross danger areas.</td></tr>
<tr><td><b>Sneak</b> (C)</td><td>Slow, low crawl preferring concealed routes. Very hard to spot; only fires at close targets unless engaged.</td></tr>
<tr><td><b>Fire</b> (F)</td><td>Engage a specific enemy, or area-fire a point to suppress suspected positions.</td></tr>
<tr><td><b>Smoke</b> (K)</td><td>Throw a smoke grenade (≈45 m), fire mortar smoke, or pop a vehicle's smoke launchers. Smoke blocks sight; thermal sights see through it partially.</td></tr>
<tr><td><b>Defend</b> (H)</td><td>Hold in place, facing the clicked direction, in the best local cover.</td></tr>
<tr><td><b>Ambush</b> (B)</td><td>Stay hidden and hold fire until the enemy comes close (≈140 m) or you are discovered.</td></tr>
<tr><td><b>Reverse</b> (V)</td><td>Vehicles back up while keeping their thick frontal armour toward the threat.</td></tr>
<tr><td><b>Mount / Dismount</b> (Y)</td><td>Infantry board a friendly Bradley, Stryker, BMP or BTR and get out behind it.</td></tr>
<tr><td><b>Call Artillery</b> (T)</td><td>Platoon HQ / forward observers call a 155 mm (NATO) or 152 mm (OPFOR) battery on a point they can observe. ~35–40 s delay, dangerous up to 100 m.</td></tr>
<tr><td><b>Recon Drone</b> (U)</td><td>Drone teams launch a quadcopter/fixed-wing UAV that orbits a point and spots everything not hidden under trees or roofs.</td></tr>
<tr><td><b>Drone Strike</b> (J)</td><td>Switchblade 600 (NATO) or FPV kamikaze drones (OPFOR) attack a spotted target through its thin top armour. They can be shot down.</td></tr>
<tr><td><b>Stop</b> (X)</td><td>Cancel orders and take cover in place.</td></tr>
</table>

<h2>Soldiers & morale</h2>
<ul>
<li><b>Suppression</b> builds when bullets and shells land close. Suppressed soldiers shoot poorly, go prone, and at high levels are <b>Pinned</b> (won't move) or <b>Cowering</b> (won't fire).</li>
<li><b>Morale</b> drops with suppression, casualties (especially leaders), being outflanked or facing tanks without anti-tank weapons. It recovers near leaders and the Platoon HQ.</li>
<li>Broken soldiers <b>panic</b> and run for cover; if it gets worse they <b>rout</b> off the map, or <b>surrender</b> when the enemy is close.</li>
<li>Cover matters enormously: buildings, walls, rubble, hedgerows, woods and shell craters stop bullets and fragments. Open fields kill.</li>
<li>Modern body armour stops many rifle rounds; heavy machine guns and high explosive do not care.</li>
</ul>

<h2>Armour</h2>
<ul>
<li>Every vehicle has front / side / rear / top armour. Hitting a tank from the side or rear, or from above with a <b>Javelin</b>, Switchblade or <b>TOW-2B</b>, is far more effective than a frontal shot.</li>
<li><b>ERA</b> (T-90M, T-72B3) degrades single-warhead HEAT rockets; tandem warheads defeat it. <b>Slat armour</b> (Stryker) catches many RPGs. The Abrams' <b>Trophy</b> active protection shoots down incoming rockets and missiles until its charges run out.</li>
<li>Knocked-out vehicles may burn; surviving crews bail out and fight on foot. Damaged vehicles can be immobilised or lose their main gun, and crews under pressure may abandon them.</li>
<li>Vehicles detect laser-guided missile launches and pop smoke — beam-riding missiles like Kornet and TOW then need line of sight through the smoke to guide.</li>
</ul>

<h2>Winning</h2>
<ul>
<li>Each battlefield has <b>victory locations</b> (flags). You hold a flag when you have effective troops on it and the enemy doesn't. Contested flags pulse yellow.</li>
<li>The battle ends when time runs out, when one side's <b>force morale</b> (top bar) collapses, or by cease-fire/withdrawal. The side holding more victory points wins.</li>
<li>Spotting works by line of sight, range, concealment and activity: firing units, moving vehicles and men standing in the open are seen first. Units in <b>Ambush</b> or <b>Sneak</b> are much harder to find. Enemy contacts that break line of sight are shown as <b>?</b> markers at their last known position.</li>
</ul>

<h2>The Operation</h2>
<p>Operation Iron Corridor is a campaign in six sectors along Route Iron. As in Market Garden, air assault infantry must seize the bridges while an armoured task force pushes up the road to relieve them — and a lone airborne battalion holds the far bridge at Arnholt. Your battlegroups carry their losses and experience from battle to battle. Win each sector to advance the corridor before the days run out.</p>`;
}
