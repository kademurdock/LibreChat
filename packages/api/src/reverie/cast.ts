interface CastStore {
  updateOne(
    filter: { userId: string; name?: string; 'attrs.desc'?: string },
    update: { $set: { name?: string; 'attrs.desc'?: string } },
  ): PromiseLike<{ modifiedCount: number }>;
}
const edits = [
  {
    userId: 'npc:pat',
    oldName: 'Pat Okafor',
    name: 'Pat Harris',
    oldDesc:
      'You hear the flat-top before you pick Pat out of the steam — broad-shouldered, towel over one shoulder, spatula conducting. The coffee is bad and Pat knows and Pat does not care, and this is the correct arrangement.',
    desc: 'Pat wears a faded diner T-shirt and keeps a towel tucked into her apron. She is working the grill, checking the tickets, and keeping an eye on anyone who has been sitting alone too long.',
  },
  {
    userId: 'npc:dez',
    oldName: 'Desmond Okafor',
    name: 'Dez Harris',
    oldDesc:
      'Behind the bar like the bar grew around him. Unbothered by anything — fires, heartbreak, requests. Pours with one hand, settles arguments with the other, rarely uses words when an eyebrow is in stock.',
    desc: 'Dez has rolled-up sleeves, a silver watch, and a pencil behind one ear. He remembers what you order. If an argument gets too loud, he comes out from behind the bar to deal with it.',
  },
  {
    userId: 'npc:merle',
    oldName: 'Merle Boggs',
    name: 'Merle Boggs',
    oldDesc:
      'A dockhand built like cargo, always eating something, always mid-favor. His boots announce him a room early. A Boggs, which the Hook says explains a lot without saying what.',
    desc: 'Merle works the docks. His boots are scuffed, his lunch is wrapped in foil, and he is usually helping somebody move something too heavy for one person.',
  },
  {
    userId: 'npc:ines',
    oldName: 'Ines Beaumont',
    name: 'Ines Beaumont',
    oldDesc:
      'The librarian. Speaks quietly and knows everyone’s business, which she files, alphabetically, behind her eyes. Cardigan sleeves pushed up like the books might require sudden action.',
    desc: 'Ines runs the Archive. She wears reading glasses on a cord and knows which shelf a book belongs on without checking. She likes the quiz team, old mysteries, and getting out of work on time.',
  },
];
export async function refreshReverieCast(store: CastStore): Promise<void> {
  for (const edit of edits) {
    if (edit.name !== edit.oldName)
      await store.updateOne(
        { userId: edit.userId, name: edit.oldName },
        { $set: { name: edit.name } },
      );
    await store.updateOne(
      { userId: edit.userId, 'attrs.desc': edit.oldDesc },
      { $set: { 'attrs.desc': edit.desc } },
    );
  }
}
