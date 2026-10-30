/**
 * Oct 29 2026: the front door asks "Will you be looking at the screen, or
 * listening?" and keeps the answer on the request. Optional: no answer and
 * "I'd rather not say" both store null, and nothing odd gets stored.
 */
const express = require('express');
const request = require('supertest');

const mockCreate = jest.fn(async (doc) => ({ _id: 'req-1', ...doc }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { sent: 1 } }) }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('~/models/kadeAccessRequest', () => ({
  KadeAccessRequest: { create: (...a) => mockCreate(...a) },
}));
jest.mock('~/models/kadeNudge', () => ({ KadePendingNudge: { create: jest.fn() } }));

const router = require('./accessRequest');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/access-request', router);
  return a;
}

const knock = (extra, ip) =>
  request(app())
    .post('/api/access-request')
    .set('x-forwarded-for', ip)
    .send({ name: 'David', contact: '417-770-4722', whoYouAre: "Kade's friend", ...extra });

beforeEach(() => mockCreate.mockClear());

test.each([
  ['sighted', 'sighted', '10.0.0.1'],
  ['nonvisual', 'nonvisual', '10.0.0.2'],
  ['unsaid', null, '10.0.0.3'],
  [undefined, null, '10.0.0.4'],
  ['<script>', null, '10.0.0.5'],
])('answer %p is stored as %p', async (given, stored, ip) => {
  const res = await knock(given === undefined ? {} : { sight: given }, ip);
  expect(res.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ sight: stored }));
});
