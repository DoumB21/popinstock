/* Shared rarity → CSS class mapping for all Topps Digital pages */
const RARITY_ORDER = [
  'Common', 'Uncommon', 'Rare', 'Super Rare', 'Epic',
  'Epic Exclusive', 'Event Exclusive', 'Legendary', 'Legendary Exclusive',
];

const RARITY_CLASS = {
  'Common':             'r-common',
  'Uncommon':           'r-uncommon',
  'Rare':               'r-rare',
  'Super Rare':         'r-royalty',
  'Epic':               'r-epic',
  'Epic Exclusive':     'r-legendary',
  'Event Exclusive':    'r-grail',
  'Legendary':          'r-mythic',
  'Legendary Exclusive':'r-1of1',
};
