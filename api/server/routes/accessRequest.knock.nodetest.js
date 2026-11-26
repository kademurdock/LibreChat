'use strict';
/* Nov 26 2026 (Part 460): which address the access-request doorbell counts.
 * Under TRUST_PROXY 1 (today) it keeps reading the first X-Forwarded-For entry,
 * because req.ip is only Railway's edge then. Under TRUST_PROXY 2 it reads
 * req.ip, the address Railway's own entries prove, so a made-up first entry no
 * longer gets a fresh 3-an-hour allowance.
 * Run: node --test api/server/routes/accessRequest.knock.nodetest.js (no network, no database). */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const stubs = {
  '@librechat/data-schemas': { logger: { warn() {}, error() {}, info() {} } },
  '~/models/kadeAccessRequest': { KadeAccessRequest: {} },
  '~/models/kadeSight': { parseSightChoice: () => null },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, ...rest);
};
const { knockAddress } = require('./accessRequest');
Module._load = realLoad;

const saved = process.env.TRUST_PROXY;
afterEach(() => {
  if (saved === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved;
});
const reqOf = (xff, ip) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, ip });

test('TRUST_PROXY unset or 1: the first X-Forwarded-For entry, as before', () => {
  delete process.env.TRUST_PROXY;
  assert.equal(knockAddress(reqOf('203.0.113.7, 79.127.178.81', '79.127.178.81')), '203.0.113.7');
  process.env.TRUST_PROXY = '1';
  assert.equal(knockAddress(reqOf('203.0.113.7, 79.127.178.81', '79.127.178.81')), '203.0.113.7');
  assert.equal(knockAddress(reqOf('', '10.0.0.5')), '10.0.0.5');
});

test('TRUST_PROXY=2: req.ip, so a made-up first entry is ignored', () => {
  process.env.TRUST_PROXY = '2';
  for (const spoof of ['6.6.6.6', '1.1.1.1', '127.0.0.1']) {
    assert.equal(knockAddress(reqOf(`${spoof}, 203.0.113.7, 79.127.178.81`, '203.0.113.7')), '203.0.113.7');
  }
  assert.equal(knockAddress(reqOf('', undefined)), '');
});
