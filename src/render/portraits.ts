import type { UnitTemplate } from '../data/units';

/**
 * Picture of a unit type (its vehicle, or a few of its soldiers posed with the unit's signature
 * weapon): static images in public/portraits/<unit id>.webp, rendered in Blender by
 * tools/blender/build_portraits.py (`npm run portraits`). Shown over a soft vignette backdrop,
 * so a missing file simply leaves the backdrop.
 */
export function unitPortrait(t: UnitTemplate): string {
  return `${import.meta.env.BASE_URL}portraits/${t.id}.webp`;
}

/** Soft backdrop behind unit portraits (they are rendered on a transparent background). */
export const PORTRAIT_BACKDROP = 'radial-gradient(ellipse at 55% 72%, #5a6650 0%, #333b31 45%, #1f251f 85%)';

/** CSS background for an element showing a unit's portrait over the backdrop. */
export const portraitBg = (t: UnitTemplate) => `background-image:url('${unitPortrait(t)}'), ${PORTRAIT_BACKDROP}`;
