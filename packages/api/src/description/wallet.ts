import mongoose from 'mongoose';

export type DescriptionWallet = {
  /** null means the platform pays for an administrator. */
  available: (owner: string) => Promise<number | null>;
  reserve: (owner: string, run: string, usd: number) => Promise<boolean>;
  settle: (owner: string, run: string, usd: number) => Promise<void>;
};

const credits = (usd: number): number => {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('Invalid processing price.');
  return Math.ceil(usd * 1e6 - 1e-6);
};
const userId = (owner: string) => new mongoose.Types.ObjectId(owner);
const field = (run: string) => {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(run)) throw new Error('Invalid processing reservation.');
  return `descriptionHolds.${run}`;
};

/** Reservations and refunds change the same balance document atomically, across replicas. */
export function createDescriptionWallet(): DescriptionWallet {
  const balances = () => mongoose.connection.collection('balances');
  const admin = async (owner: string): Promise<boolean> => {
    const user = await mongoose.connection
      .collection('users')
      .findOne({ _id: userId(owner) }, { projection: { role: 1 } });
    return user?.role === 'ADMIN';
  };
  return {
    async available(owner) {
      if (await admin(owner)) return null;
      const balance = await balances().findOne({ user: userId(owner) });
      return Math.max(0, Number(balance?.tokenCredits) || 0) / 1e6;
    },
    async reserve(owner, run, usd) {
      const amount = credits(usd);
      if (!amount || (await admin(owner))) return true;
      const key = field(run);
      const result = await balances().updateOne(
        { user: userId(owner), tokenCredits: { $gte: amount }, [key]: { $exists: false } },
        { $inc: { tokenCredits: -amount }, $set: { [key]: amount } },
      );
      if (result.modifiedCount) return true;
      const already = await balances().findOne({ user: userId(owner), [key]: amount });
      return !!already;
    },
    async settle(owner, run, usd) {
      const charge = credits(usd);
      const key = field(run);
      for (;;) {
        const balance = await balances().findOne({ user: userId(owner) });
        if (!balance) return;
        const held = balance.descriptionHolds?.[run];
        if (held === undefined) {
          // Fence a reservation still in flight when its crashed job is recovered.
          const closed = await balances().updateOne(
            { user: userId(owner), [key]: { $exists: false } },
            { $set: { [key]: -1 } },
          );
          if (closed.modifiedCount) return;
          continue;
        }
        if (typeof held !== 'number' || held < 0) return;
        // A provider overrun is a platform expense, never an extra customer debit.
        const closed = await balances().updateOne(
          { user: userId(owner), [key]: held },
          { $inc: { tokenCredits: held - Math.min(held, charge) }, $set: { [key]: -1 } },
        );
        if (closed.modifiedCount) return;
      }
    },
  };
}
