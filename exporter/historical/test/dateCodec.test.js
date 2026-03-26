const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeFToken, decodePackedDate, encodeFToken } = require('../dateCodec');

test('decodePackedDate accepts 1920-offset years', () => {
  const packed = ((2022 - 1920) << 9) | (6 << 5) | 11;
  assert.equal(decodePackedDate(packed), '2022-06-11');
});

test('decodePackedDate accepts absolute years', () => {
  const packed = (2022 << 9) | (6 << 5) | 11;
  assert.equal(decodePackedDate(packed), '2022-06-11');
});

test('fToken round-trips through the shared codec', () => {
  const fToken = encodeFToken(2022, 6, 11);
  assert.deepEqual(decodeFToken(fToken), {
    year: 2022,
    month: 6,
    day: 11,
    date: '2022-06-11',
  });
});
