const test = require('node:test');
const assert = require('node:assert/strict');

const { latLonToPath, slippyTileToBounds, slippyTileToCenter } = require('../pathUtils');

test('slippy tile path selection uses the covered cell center instead of the northwest corner', () => {
  const bounds = slippyTileToBounds(1, 0, 1);
  const center = slippyTileToCenter(1, 0, 1);

  const cornerPath = latLonToPath(bounds.north, bounds.west, 1);
  const centerPath = latLonToPath(center.lat, center.lon, 1);

  assert.equal(cornerPath, '03');
  assert.equal(centerPath, '00');
  assert.notEqual(cornerPath, centerPath);
});
