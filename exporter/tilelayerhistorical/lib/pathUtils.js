const ZERO_TILE_GEO_SIZE = 360;
const VALID_BOUND_RC = [-180.0, 180.0, 180.0, -180.0];

function getTileGeoSize(level) {
  return ZERO_TILE_GEO_SIZE / Math.pow(2, level);
}

function getRowColInfoChar(rowIndex, colIndex) {
  const rowOdd = rowIndex % 2;
  const colOdd = colIndex % 2;

  if (rowOdd > 0 && colOdd > 0) return '2';
  if (rowOdd > 0 && colOdd === 0) return '3';
  if (rowOdd === 0 && colOdd === 0) return '0';
  return '1';
}

function latLonToPath(lat, lon, zoom) {
  let pathCode = '';

  for (let level = 0; level <= zoom; level += 1) {
    const tileSize = getTileGeoSize(level);
    const colIndex = Math.floor((lon - VALID_BOUND_RC[0]) / tileSize);
    const rowIndex = Math.floor((lat - VALID_BOUND_RC[3]) / tileSize);
    pathCode += getRowColInfoChar(rowIndex, colIndex);
  }

  return pathCode;
}

function normalizeBounds(rawBounds) {
  if (!rawBounds) {
    throw new Error('Bounds are required.');
  }

  if (
    typeof rawBounds.north === 'number' &&
    typeof rawBounds.south === 'number' &&
    typeof rawBounds.east === 'number' &&
    typeof rawBounds.west === 'number'
  ) {
    return {
      north: rawBounds.north,
      south: rawBounds.south,
      east: rawBounds.east,
      west: rawBounds.west,
    };
  }

  if (rawBounds.ne && rawBounds.sw) {
    return {
      north: rawBounds.ne.lat,
      south: rawBounds.sw.lat,
      east: rawBounds.ne.lon,
      west: rawBounds.sw.lon,
    };
  }

  if (rawBounds._northEast && rawBounds._southWest) {
    return {
      north: rawBounds._northEast.lat,
      south: rawBounds._southWest.lat,
      east: rawBounds._northEast.lng,
      west: rawBounds._southWest.lng,
    };
  }

  throw new Error('Unsupported bounds payload.');
}

function buildPathCellsForBounds(rawBounds, zoom) {
  const bounds = normalizeBounds(rawBounds);
  const tileSize = getTileGeoSize(zoom);
  const colLeft = Math.floor((bounds.west - VALID_BOUND_RC[0]) / tileSize);
  const colRight = Math.floor((bounds.east - VALID_BOUND_RC[0]) / tileSize);
  const rowBottom = Math.floor((bounds.south - VALID_BOUND_RC[3]) / tileSize);
  const rowTop = Math.floor((bounds.north - VALID_BOUND_RC[3]) / tileSize);
  const dedupe = new Set();
  const cells = [];

  for (let row = rowBottom; row <= rowTop; row += 1) {
    for (let col = colLeft; col <= colRight; col += 1) {
      const south = row * tileSize + VALID_BOUND_RC[3];
      const west = col * tileSize + VALID_BOUND_RC[0];
      const north = south + tileSize;
      const east = west + tileSize;
      const centerLat = (south + north) / 2;
      const centerLon = (west + east) / 2;
      const pathCode = latLonToPath(centerLat, centerLon, zoom);

      if (dedupe.has(pathCode)) {
        continue;
      }

      dedupe.add(pathCode);
      cells.push({
        path: pathCode,
        row,
        col,
        center: {
          lat: centerLat,
          lon: centerLon,
        },
        bounds: {
          north,
          south,
          east,
          west,
        },
      });
    }
  }

  return cells;
}

function slippyTileToBounds(z, x, y) {
  const tileCount = Math.pow(2, z);

  const west = (x / tileCount) * 360 - 180;
  const east = ((x + 1) / tileCount) * 360 - 180;

  function mercatorToLat(tileY) {
    const n = Math.PI - (2 * Math.PI * tileY) / tileCount;
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  }

  return {
    north: mercatorToLat(y),
    south: mercatorToLat(y + 1),
    east,
    west,
  };
}

function slippyTileToCenter(z, x, y) {
  const bounds = slippyTileToBounds(z, x, y);

  return {
    lat: (bounds.north + bounds.south) / 2,
    lon: (bounds.east + bounds.west) / 2,
    bounds,
  };
}

module.exports = {
  VALID_BOUND_RC,
  ZERO_TILE_GEO_SIZE,
  buildPathCellsForBounds,
  getRowColInfoChar,
  getTileGeoSize,
  latLonToPath,
  normalizeBounds,
  slippyTileToBounds,
  slippyTileToCenter,
};
