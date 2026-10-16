// Named colours. Every colour a person can pick has a spoken name, so a blind builder
// chooses "honey blonde", never a hex code.

export const SKIN = [
  { id: 'porcelain', name: 'Porcelain', hex: '#FBE4D8', note: 'very fair with pink undertones' },
  { id: 'fair', name: 'Fair', hex: '#F5D2BC', note: 'fair and peachy' },
  { id: 'light-beige', name: 'Light beige', hex: '#EEC5A3', note: 'light and warm' },
  { id: 'warm-beige', name: 'Warm beige', hex: '#E3B08A', note: 'medium-light and warm' },
  { id: 'golden', name: 'Golden', hex: '#D6A075', note: 'medium with golden undertones' },
  { id: 'olive', name: 'Olive', hex: '#C59D72', note: 'medium with olive undertones' },
  { id: 'tan', name: 'Tan', hex: '#BC8659', note: 'sun-kissed tan' },
  { id: 'caramel', name: 'Caramel', hex: '#A56B42', note: 'warm medium brown' },
  { id: 'bronze', name: 'Bronze', hex: '#8E5737', note: 'rich bronze brown' },
  { id: 'brown', name: 'Brown', hex: '#76472D', note: 'deep warm brown' },
  { id: 'deep-brown', name: 'Deep brown', hex: '#5C3524', note: 'deep brown' },
  { id: 'ebony', name: 'Ebony', hex: '#43281B', note: 'very deep brown' },
  { id: 'lavender', name: 'Lavender', hex: '#CBB6EA', note: 'fantasy lavender', fantasy: true },
  { id: 'mint', name: 'Mint', hex: '#A9E2C8', note: 'fantasy mint green', fantasy: true },
  { id: 'sky', name: 'Sky blue', hex: '#AACCF0', note: 'fantasy sky blue', fantasy: true },
  { id: 'rose', name: 'Rose', hex: '#F3AFC2', note: 'fantasy rose pink', fantasy: true },
  { id: 'leaf', name: 'Leaf green', hex: '#90C68D', note: 'fantasy leaf green', fantasy: true },
  { id: 'chrome', name: 'Chrome', hex: '#C6CDD6', note: 'polished silver, like a friendly robot', fantasy: true },
];

export const HAIR = [
  { id: 'jet-black', name: 'Jet black', hex: '#1E1B20' },
  { id: 'soft-black', name: 'Soft black', hex: '#302824' },
  { id: 'dark-brown', name: 'Dark brown', hex: '#4A2F21' },
  { id: 'chestnut', name: 'Chestnut', hex: '#6F3F25' },
  { id: 'auburn', name: 'Auburn', hex: '#813423' },
  { id: 'copper', name: 'Copper red', hex: '#B4552B' },
  { id: 'strawberry-blonde', name: 'Strawberry blonde', hex: '#D38E5E' },
  { id: 'honey-blonde', name: 'Honey blonde', hex: '#D7A65C' },
  { id: 'golden-blonde', name: 'Golden blonde', hex: '#E4C276' },
  { id: 'platinum', name: 'Platinum blonde', hex: '#EFE5C9' },
  { id: 'silver', name: 'Silver', hex: '#C3C6CC' },
  { id: 'snow-white', name: 'Snow white', hex: '#F1F0EC' },
  { id: 'salt-and-pepper', name: 'Salt and pepper', hex: '#85827E' },
  { id: 'bubblegum', name: 'Bubblegum pink', hex: '#F28DB3', fantasy: true },
  { id: 'electric-blue', name: 'Electric blue', hex: '#3E7CF0', fantasy: true },
  { id: 'violet', name: 'Violet', hex: '#8A5CD6', fantasy: true },
  { id: 'mint-green', name: 'Mint green', hex: '#6CCFA7', fantasy: true },
  { id: 'sunset-orange', name: 'Sunset orange', hex: '#F28A3C', fantasy: true },
  { id: 'teal', name: 'Teal', hex: '#2E9C9A', fantasy: true },
];

export const EYES = [
  { id: 'dark-brown', name: 'Dark brown', hex: '#3A2416' },
  { id: 'brown', name: 'Brown', hex: '#6A3D1F' },
  { id: 'hazel', name: 'Hazel', hex: '#86682E' },
  { id: 'amber', name: 'Amber', hex: '#B4791E' },
  { id: 'green', name: 'Green', hex: '#4D7F3A' },
  { id: 'blue', name: 'Blue', hex: '#3D76B4' },
  { id: 'ice-blue', name: 'Ice blue', hex: '#8BB8DE' },
  { id: 'gray', name: 'Gray', hex: '#7B868E' },
  { id: 'violet', name: 'Violet', hex: '#7954B8', fantasy: true },
  { id: 'gold', name: 'Gold', hex: '#D8A31E', fantasy: true },
  { id: 'ruby', name: 'Ruby', hex: '#B4283B', fantasy: true },
];

export const CLOTH = [
  { id: 'white', name: 'White', hex: '#F4F2EE' },
  { id: 'cream', name: 'Cream', hex: '#EFE3C8' },
  { id: 'heather-gray', name: 'Heather gray', hex: '#A7A9AD' },
  { id: 'charcoal', name: 'Charcoal', hex: '#3C3F45' },
  { id: 'black', name: 'Black', hex: '#1F2023' },
  { id: 'navy', name: 'Navy', hex: '#24345C' },
  { id: 'denim', name: 'Denim blue', hex: '#456C9E' },
  { id: 'sky', name: 'Sky blue', hex: '#8CC0E8' },
  { id: 'teal', name: 'Teal', hex: '#23807F' },
  { id: 'forest', name: 'Forest green', hex: '#2F5D3E' },
  { id: 'sage', name: 'Sage', hex: '#9CB38E' },
  { id: 'mustard', name: 'Mustard', hex: '#D4A132' },
  { id: 'sunflower', name: 'Sunflower yellow', hex: '#F2C744' },
  { id: 'tangerine', name: 'Tangerine', hex: '#EE7C35' },
  { id: 'brick', name: 'Brick red', hex: '#A3402D' },
  { id: 'cherry', name: 'Cherry red', hex: '#C42A3A' },
  { id: 'rose', name: 'Rose pink', hex: '#E58AA6' },
  { id: 'lavender', name: 'Lavender', hex: '#B49BDB' },
  { id: 'plum', name: 'Plum', hex: '#6D3466' },
  { id: 'chocolate', name: 'Chocolate', hex: '#5A3826' },
  { id: 'camel', name: 'Camel', hex: '#C08D57' },
  { id: 'gold', name: 'Gold', hex: '#D6AE45' },
  { id: 'silver', name: 'Silver', hex: '#BFC4CB' },
];

export const LIPS = [
  { id: 'natural', name: 'Natural', hex: null },
  { id: 'rosy', name: 'Rosy', hex: '#D36F7E' },
  { id: 'nude', name: 'Nude', hex: '#C58C7A' },
  { id: 'coral', name: 'Coral', hex: '#E86F5C' },
  { id: 'red', name: 'Classic red', hex: '#B81E2F' },
  { id: 'berry', name: 'Berry', hex: '#8E2A4E' },
  { id: 'plum', name: 'Plum', hex: '#5E2443' },
  { id: 'black', name: 'Black', hex: '#2A1F24' },
];

export const BACKDROPS = [
  { id: 'none', name: 'No backdrop' },
  { id: 'dusk', name: 'Dusk purple', a: '#3B2E5A', b: '#1C1730' },
  { id: 'ocean', name: 'Ocean blue', a: '#2C5E8A', b: '#122840' },
  { id: 'meadow', name: 'Meadow green', a: '#4E7E4C', b: '#1F3A22' },
  { id: 'sunrise', name: 'Sunrise peach', a: '#F2B48A', b: '#B8624F' },
  { id: 'studio', name: 'Studio gray', a: '#6E7178', b: '#2B2D31' },
  { id: 'cream', name: 'Soft cream', a: '#F4EAD8', b: '#D8C6A6' },
];

export const byId = (list, id, fallback = 0) => list.find((c) => c.id === id) || list[fallback];
