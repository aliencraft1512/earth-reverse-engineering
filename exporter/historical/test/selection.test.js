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

test('best-valid-per-path mode keeps the same date/token selected when the exact version changes', () => {
  const previousEntry = { date: '2025-07-02', iCode: 364, fToken: 'fd2e2', pathCount: 9 };
  const nextEntries = [
    { date: '2025-07-02', iCode: 362, fToken: 'fd2e2', pathCount: 12 },
    { date: '2024-05-20', iCode: 350, fToken: 'fd0b4', pathCount: 12 },
  ];

  assert.equal(
    reconcileSelection(makeEntryId(previousEntry), nextEntries, { preferExactVersion: false }),
    makeEntryId(nextEntries[0])
  );
});
