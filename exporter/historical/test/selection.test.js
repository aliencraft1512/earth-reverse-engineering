const test = require('node:test');
const assert = require('node:assert/strict');

const { makeEntryId, reconcileSelection } = require('../public/selection');

test('same-date siblings keep unique selection identity', () => {
  const entries = [
    { date: '2022-06-10', iCode: 316, fToken: 'fcccb' },
    { date: '2022-06-10', iCode: 312, fToken: 'fcccb' },
  ];
  const selectedEntryId = makeEntryId(entries[0]);

  assert.equal(reconcileSelection(selectedEntryId, entries), selectedEntryId);
  assert.equal(reconcileSelection(selectedEntryId, [entries[1]]), null);
});
