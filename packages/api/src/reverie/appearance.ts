export interface ReverieAppearance {
  build: string;
  hair: string;
  style: string;
}

const residentClothes: { [id: string]: string } = {
  'npc:pat': 'faded diner T-shirt and apron',
  'npc:merle': 'work clothes and scuffed boots',
  'npc:ines': 'reading glasses on a cord',
  'npc:dez': 'rolled-up sleeves and a silver watch',
  'npc:nell': 'soft cardigan with pushed-up sleeves',
};

export function residentAppearance(id: string): ReverieAppearance | null {
  const style = residentClothes[id];
  return style ? { build: '', hair: '', style } : null;
}

/** Public creation choices only. Never serialize the rest of a resident's life. */
export function reverieAppearance(attrs?: {
  life?: { look?: Partial<ReverieAppearance> };
}): ReverieAppearance | null {
  const look = attrs?.life?.look;
  if (!look) return null;
  const field = (value?: string) =>
    // Strip control characters from public labels before exposing them to clients.
    // eslint-disable-next-line no-control-regex
    typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) : '';
  const result = { build: field(look.build), hair: field(look.hair), style: field(look.style) };
  return result.build || result.hair || result.style ? result : null;
}
