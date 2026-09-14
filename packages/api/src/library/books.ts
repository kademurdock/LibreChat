const reviewedBooks: { title: string; author: string; shelf: string }[] = [
  {
    "title": "A Light in the Attic",
    "author": "Shel Silverstein",
    "shelf": "Poetry"
  },
  {
    "title": "A Look Into Our \"i's\": A Compilation of Introspective Writings From a Group of Extraordinary Young People With Visual Impairments",
    "author": "Delta Gamma Center For Children With Visual Impairments",
    "shelf": "Nonfiction — Biography & memoir"
  },
  {
    "title": "BreakupBabe",
    "author": "Rebecca Agiewich",
    "shelf": "Fiction — Romance"
  },
  {
    "title": "Diagnostic and Statistical Manual of Mental Disorders, (DSM-IV), 4th edition",
    "author": "American Psychiatric Association",
    "shelf": "Nonfiction — Health & fitness"
  },
  {
    "title": "Falling Up",
    "author": "Shel Silverstein",
    "shelf": "Poetry"
  },
  {
    "title": "Have You Met Miss Jones?",
    "author": "Tarsha Jones",
    "shelf": "Nonfiction — Biography & memoir"
  },
  {
    "title": "How Does Aspirin Find a Headache?",
    "author": "David Feldman",
    "shelf": "Nonfiction — Reference & how-to"
  },
  {
    "title": "Imponderables",
    "author": "David Feldman",
    "shelf": "Nonfiction — Reference & how-to"
  },
  {
    "title": "Little Women Next Door",
    "author": "Sheila Solomon Klass",
    "shelf": "Fiction — Historical"
  },
  {
    "title": "Mildred D. Taylor: The Logan Family Saga Complete Collection",
    "author": "Mildred D. Taylor",
    "shelf": "Fiction — Young adult"
  },
  {
    "title": "Nothing But Drama",
    "author": "Reshonda Tate Billingsley",
    "shelf": "Fiction — Young adult"
  },
  {
    "title": "Psychology (3rd Edition)",
    "author": "Saundra K. Ciccarelli, J. Noland White",
    "shelf": "Nonfiction — Science & nature"
  },
  {
    "title": "Runny Babbit: A Billy Sook",
    "author": "Shel Silverstein",
    "shelf": "Poetry"
  },
  {
    "title": "Set Your Voice Free",
    "author": "Roger Love, Donna Frazier",
    "shelf": "Nonfiction — Music & entertainment"
  },
  {
    "title": "Textured Tresses",
    "author": "Paula T. Renfroe, Diane Da Costa, Blair Underwood",
    "shelf": "Nonfiction — Health & fitness"
  },
  {
    "title": "The Hot Box",
    "author": "Zane",
    "shelf": "Fiction — Romance"
  },
  {
    "title": "Traveling Blind: Life Lessons From Unlikely Teachers",
    "author": "Laura Fogg",
    "shelf": "Nonfiction — Biography & memoir"
  },
  {
    "title": "What Are Hyenas Laughing at, Anyway?",
    "author": "David Feldman",
    "shelf": "Nonfiction — Reference & how-to"
  },
  {
    "title": "When Do Fish Sleep?",
    "author": "David Feldman",
    "shelf": "Nonfiction — Reference & how-to"
  },
  {
    "title": "You're Only Old Once!",
    "author": "Seuss",
    "shelf": "Nonfiction — Humor & jokes"
  }
];

/** Series-level corrections supported by the catalog's own synopses. */
export function correctedBookShelf(title: string, author = '', path = ''): string | null {
  const reviewed = reviewedBooks.find((book) => book.title === title && book.author === author);
  if (reviewed) return reviewed.shelf;
  if (/^chicken soup (?:for|for the)/i.test(title)) return 'Nonfiction — Inspirational stories';
  if (title === 'The Wisdom of a Broken Heart') return 'Nonfiction — Self-help & relationships';
  if (title === 'Erotic City' && /pynk/i.test(author)) return 'Fiction — Urban';
  // Earlier imported shelf labels contain a replacement character instead of a dash.
  const damaged = path.match(/^Books\/(Fiction|Nonfiction)\s+[\uFFFD]\s+(.+)$/);
  if (damaged) return damaged[1] + ' — ' + damaged[2];
  return null;
}
