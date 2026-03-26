const { Jimp, JimpMime, ResizeStrategy } = require('jimp');

const QUADRANT_BY_DIGIT = {
  '0': { xFactor: 0, yFactor: 1 },
  '1': { xFactor: 1, yFactor: 1 },
  '2': { xFactor: 1, yFactor: 0 },
  '3': { xFactor: 0, yFactor: 0 },
};

function getCropWindowForSuffix(width, height, suffix) {
  let x = 0;
  let y = 0;
  let currentWidth = width;
  let currentHeight = height;

  for (const digit of suffix) {
    const quadrant = QUADRANT_BY_DIGIT[digit];

    if (!quadrant) {
      throw new Error(`Unsupported child path digit "${digit}"`);
    }

    const halfWidth = Math.max(1, Math.floor(currentWidth / 2));
    const halfHeight = Math.max(1, Math.floor(currentHeight / 2));

    if (quadrant.xFactor === 1) {
      x += halfWidth;
    }

    if (quadrant.yFactor === 1) {
      y += halfHeight;
    }

    currentWidth = halfWidth;
    currentHeight = halfHeight;
  }

  return {
    x,
    y,
    width: currentWidth,
    height: currentHeight,
  };
}

async function cropBufferToSuffix(buffer, suffix, mime = JimpMime.jpeg) {
  if (!suffix) {
    return Buffer.from(buffer);
  }

  const image = await Jimp.read(buffer);
  const outputWidth = image.bitmap.width;
  const outputHeight = image.bitmap.height;
  const cropWindow = getCropWindowForSuffix(outputWidth, outputHeight, suffix);
  const cropped = image
    .clone()
    .crop({
      x: cropWindow.x,
      y: cropWindow.y,
      w: cropWindow.width,
      h: cropWindow.height,
    })
    .resize({
      w: outputWidth,
      h: outputHeight,
      mode: ResizeStrategy.BILINEAR,
    });

  return cropped.getBuffer(mime);
}

module.exports = {
  QUADRANT_BY_DIGIT,
  cropBufferToSuffix,
  getCropWindowForSuffix,
};
