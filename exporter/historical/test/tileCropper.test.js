const test = require('node:test');
const assert = require('node:assert/strict');

const { Jimp, JimpMime } = require('jimp');

const { cropBufferToSuffix } = require('../tileCropper');

function rgbaToHex(red, green, blue, alpha = 255) {
  return (
    (((red & 0xff) << 24) |
      ((green & 0xff) << 16) |
      ((blue & 0xff) << 8) |
      (alpha & 0xff)) >>> 0
  );
}

test('cropBufferToSuffix returns the correct child quadrant', async () => {
  const image = new Jimp({ width: 4, height: 4, color: rgbaToHex(0, 0, 0) });
  const colors = {
    nw: rgbaToHex(255, 0, 0),
    ne: rgbaToHex(0, 255, 0),
    sw: rgbaToHex(0, 0, 255),
    se: rgbaToHex(255, 255, 0),
  };

  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const isNorth = y < 2;
      const isWest = x < 2;
      const color = isNorth
        ? (isWest ? colors.nw : colors.ne)
        : (isWest ? colors.sw : colors.se);
      image.setPixelColor(color, x, y);
    }
  }

  const sourceBuffer = await image.getBuffer(JimpMime.png);
  const croppedBuffer = await cropBufferToSuffix(sourceBuffer, '2', JimpMime.png);
  const croppedImage = await Jimp.read(croppedBuffer);

  assert.equal(croppedImage.getPixelColor(0, 0), colors.ne);
  assert.equal(croppedImage.getPixelColor(3, 3), colors.ne);
});
