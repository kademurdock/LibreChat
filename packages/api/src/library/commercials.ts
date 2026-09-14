export const commercialBrands: { [shelf: string]: string[] } = {
  'Toys & Video Games': ['tyco super blocks'],
  'Medicine & Pharmacy': ['unisom', 'comtrex', 'bayer', 'ben gay', 'bengay', 'lanacane', 'sinutab', 'dristan', 'blistex', 'actifed', 'sucrets', 'sominex', 'correctol', 'dulcolax', 'gas x', 'preparation h', 'phillips milk of magnesia', 'doans', 'doan s'],
  'Breakfast Cereal': ['special k', 'crispix', 'grape nuts', 'cream of wheat', 'frosted mini wheats', 'honey bunches of oats', 'honeycomb', 'alpha bits', 'apple jacks'],
  'Candy, Gum & Chocolate': ['m ms', 'm m s', 'doublemint', 'freedent', 'mentos', 'certs', 'dentyne', 'bubblicious', 'bubble yum', 'chiclets'],
  'Drinks (Non-Alcoholic)': ['sunny delight', 'minute maid', 'tropicana', 'ocean spray', 'welch s', 'welchs', 'crystal light', 'country time', 'five alive', 'v8 juice'],
  'Beer, Wine & Spirits': ['miller genuine draft', 'miller high life', 'miller beer', 'old milwaukee', 'pabst blue ribbon', 'lowenbrau', 'molson', 'strohs'],
  'Food & Grocery': ['hillshire farm', 'eggo', 'bisquick', 'uncle ben s', 'uncle bens', 'hidden valley ranch', 'minute rice', 'cool whip', 'mazola', 'perdue', 'dinty moore', 'campbells soup', 'campbell s soup', 'pam cooking', 'hunt s', 'hunts ketchup', 'nestle toll house'],
  'Snacks, Chips & Cookies': ['hostess', 'orville redenbacher', 'famous amos', 'little debbie', 'snackwell', 'planters'],
  'Cleaning & Household': ['drano', 'liquid plumr', 'endust', 'glass plus', 'top job', 'cottonelle', 'lysol', 'pledge polish', 'raid insect', 'damp rid'],
  'Health & Beauty': ['salon selectives', 'pert plus', 'vidal sassoon', 'arrid extra dry', 'final net', 'jhirmack', 'aquafresh', 'pepsodent', 'brylcreem', 'noxzema', 'sea breeze cleanser'],
  'Pet Products': ['gravy train', 'fresh step', 'mighty dog', 'kal kan', 'pounce cat', 'cycle dog food'],
  'Furniture & Mattresses': ['big sur waterbeds', 'craftmatic', 'sealy', 'serta', 'simmons beautyrest'],
  'Banks & Insurance': ['the money store', 'western union', 'household finance', 'beneficial finance', 'prudential', 'metlife'],
  'Stores & Retail': ['shop rite', 'shoprite', 'jc penney', 'j c penney', 'grand union', 'pathmark', 'food world', 'publix', 'waldbaum s', 'crazy eddie', 'a p supermarket'],
  'Clothing & Shoes': ['just for feet', 'british knights', 'l a gear', 'stride rite'],
  'Newspapers, Magazines & Books': ['national enquirer', 'weekly world news'],
  'Greeting Cards & Gifts': ['hallmark greeting', 'hallmark cards', 'hallmark holiday', 'hallmark ad', 'hallmark commercial'],
  'Restaurants & Fast Food': ['dunkin donuts', 'dunkin doughnuts', 'roy rogers restaurant', 'carvel'],
  'Feminine & Personal Care': ['care free', 'carefree panty', 'carefree liner'],
};
const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Only refine the catch-all shelf. A specific human filing always wins. */
export function commercialPath(path: string, title: string): string | null {
  if (!/(^|\/)Commercials\/Other Commercials(?:\/|$)/i.test(path)) return null;
  const name = ' ' + normalize(title) + ' ';
  if (name.includes(' earth 2 1994 tv series ')) return path.replace(/Commercials\/Other Commercials/i, 'TV Shows/Earth 2');
  if (name.includes(' cfmt station id and promos ')) return path.replace(/Commercials\/Other Commercials/i, 'Channels/CFMT');
  const matches = Object.entries(commercialBrands).filter(([, brands]) => brands.some((brand) => name.includes(' ' + brand + ' ')));
  if (matches.length !== 1) return null;
  return path.replace(/\/Other Commercials(?=\/|$)/i, '/' + matches[0][0]);
}
