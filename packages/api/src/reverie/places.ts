export const GULLY_LAUNDRY = {
  roomId: 'gully_laundry',
  name: 'the Gully Washhouse',
  district: 'patch',
  desc: 'Washers turn behind round glass doors. Warm air carries laundry soap and clean cotton. A wide folding table runs down the middle, with a bench beside the front window. Nell keeps spare buttons in a blue tin. Gully Road is southwest through the screen door.',
  exits: { sw: 'patch_gully_road' },
  props: {
    outdoor: false,
    surface: 'linoleum',
    smell: 'Laundry soap, clean cotton, and warm air from the dryers.',
    listenLine: 'A steady washer motor turns under the soft tumble of damp cloth.',
    doings: 'Wash clothes, fold laundry, talk to Nell, or sit while the machines turn.',
    sleepable: true,
  },
};

export function laundryAction(command: string): { line: string; clean: number; doing: string } {
  return command === 'fold laundry'
    ? {
        line: 'You fold the warm laundry into a neat stack on the table.',
        clean: 0,
        doing: 'folding warm laundry',
      }
    : {
        line: 'You wash a small load and bring it back warm from the dryer. Nell points you toward the folding table.',
        clean: 18,
        doing: 'washing clothes',
      };
}
