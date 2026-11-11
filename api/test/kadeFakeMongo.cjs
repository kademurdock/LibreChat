'use strict';
/**
 * A small in-memory stand-in for a MongoDB collection, for node:test suites that must not need
 * a real database (Nov 10 2026, the spend gate tests). It keeps the two properties those tests
 * rest on: every call yields to the event loop first, so parallel calls interleave as they do
 * against a server, and one findOneAndUpdate checks and writes in a single step (with a
 * duplicate key error, code 11000, when an upsert collides on _id).
 * Supports equality and $exists, $ne, $gte, $gt, $lt, $lte, $in, $nin; updates $set, $unset, $inc.
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));

const val = (v) => (v instanceof Date ? v.getTime() : v);

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, want]) => {
    const have = doc[key];
    const ops = want && typeof want === 'object' && !(want instanceof Date) && Object.keys(want).every((k) => k.startsWith('$'));
    if (!ops) return val(have) === val(want);
    return Object.entries(want).every(([op, x]) => {
      if (op === '$exists') return (have !== undefined) === Boolean(x);
      if (op === '$ne') return val(have) !== val(x);
      if (op === '$in') return x.map(val).includes(val(have));
      if (op === '$nin') return !x.map(val).includes(val(have));
      if (have === undefined || have === null) return false;
      if (op === '$gte') return val(have) >= val(x);
      if (op === '$gt') return val(have) > val(x);
      if (op === '$lt') return val(have) < val(x);
      if (op === '$lte') return val(have) <= val(x);
      throw new Error('fake mongo: unsupported operator ' + op);
    });
  });
}

function apply(doc, update = {}) {
  for (const [k, v] of Object.entries(update.$set || {})) doc[k] = v;
  for (const k of Object.keys(update.$unset || {})) delete doc[k];
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (Number(doc[k]) || 0) + v;
}

function sorted(rows, sort) {
  if (!sort) return rows;
  const keys = Object.entries(sort);
  return rows.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const d = val(a[k]) - val(b[k]);
      if (d) return d * dir;
    }
    return 0;
  });
}

class FakeCollection {
  constructor() {
    this.rows = [];
    this.seq = 0;
  }

  async findOne(filter, opts = {}) {
    await tick();
    const row = sorted(this.rows.filter((r) => matches(r, filter)), opts.sort)[0];
    return row ? { ...row } : null;
  }

  async insertOne(doc) {
    await tick();
    const row = { ...doc };
    if (row._id === undefined) row._id = `id${++this.seq}`;
    if (this.rows.some((r) => r._id === row._id)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    this.rows.push(row);
    return { insertedId: row._id };
  }

  async findOneAndUpdate(filter, update, opts = {}) {
    await tick();
    let row = sorted(this.rows.filter((r) => matches(r, filter)), opts.sort)[0];
    if (!row) {
      if (!opts.upsert) return null;
      row = {};
      for (const [k, v] of Object.entries(filter)) {
        if (!(v && typeof v === 'object' && !(v instanceof Date))) row[k] = v;
      }
      if (row._id === undefined) row._id = `id${++this.seq}`;
      if (this.rows.some((r) => r._id === row._id)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      apply(row, update);
      this.rows.push(row);
      return opts.returnDocument === 'after' ? { ...row } : null;
    }
    const before = { ...row };
    apply(row, update);
    return opts.returnDocument === 'after' ? { ...row } : before;
  }

  async updateOne(filter, update) {
    await tick();
    const row = this.rows.find((r) => matches(r, filter));
    if (row) apply(row, update);
    return { modifiedCount: row ? 1 : 0 };
  }

  async updateMany(filter, update) {
    await tick();
    const hit = this.rows.filter((r) => matches(r, filter));
    hit.forEach((r) => apply(r, update));
    return { modifiedCount: hit.length };
  }

  async deleteOne(filter) {
    await tick();
    const i = this.rows.findIndex((r) => matches(r, filter));
    if (i >= 0) this.rows.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }

  async deleteMany(filter) {
    await tick();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, filter));
    return { deletedCount: before - this.rows.length };
  }

  /* Nov 11 2026: enough of find() for `await c.find(filter).toArray()`. */
  find(filter, opts = {}) {
    return {
      toArray: async () => {
        await tick();
        return sorted(this.rows.filter((r) => matches(r, filter)), opts.sort).map((r) => ({ ...r }));
      },
    };
  }

  async countDocuments(filter) {
    await tick();
    return this.rows.filter((r) => matches(r, filter)).length;
  }
}

/** Serve stand-ins for modules a suite cannot load here ('~/...' paths, workspace packages). */
function stubModules(stubs) {
  const Module = require('module');
  const real = Module._load;
  Module._load = function load(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.call(this, request, ...rest);
  };
  return () => {
    Module._load = real;
  };
}

module.exports = { FakeCollection, stubModules, matches };
