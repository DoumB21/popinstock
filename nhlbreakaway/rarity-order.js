// Canonical NHL Breakaway rarity tier order (low → high), matching the
// game's own tier progression — see reference_nhlbreakaway_rarity_colors
// memory, which pulled these 8 tiers directly from nhlbreakaway.com's CSS.
// Shared by sets.html and highlights.html so rarity dropdowns/sorts stay
// consistent across the section instead of each page inventing its own order.
const RARITY_ORDER = ['Core', 'Fandom', 'Rare', 'Limited', 'Legendary', 'Epic', 'Heroic', 'Mythic'];

function sortByRarityOrder(values) {
  return [...values].sort((a, b) => {
    const ai = RARITY_ORDER.indexOf(a);
    const bi = RARITY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}
