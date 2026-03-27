
const lat = 35.1856;
const lon = 33.3823;
const target = "0202002311211002";

function getRowColInfoChar(rowIndex, colIndex) {
  const rowOdd = Math.abs(rowIndex) % 2;
  const colOdd = Math.abs(colIndex) % 2;
  if (rowOdd > 0 && colOdd > 0) return '2';
  if (rowOdd > 0 && colOdd === 0) return '3';
  if (rowOdd === 0 && colOdd === 0) return '0';
  return '1';
}

function test(south, zeroSize) {
    let path = '';
    for (let level = 0; level < target.length; level++) {
        const tileSize = zeroSize / Math.pow(2, level);
        const colIndex = Math.floor((lon - (-180)) / tileSize);
        const rowIndex = Math.floor((lat - south) / tileSize);
        path += getRowColInfoChar(rowIndex, colIndex);
    }
    return path;
}

const souths = [-180, -90, 0, -270];
const sizes = [360, 180, 512, 256];

for (const s of souths) {
    for (const z of sizes) {
        const p = test(s, z);
        if (p.startsWith(target.substring(0, 4))) {
            console.log(`MATCH FOUND! South: ${s}, ZeroSize: ${z}, Path: ${p}`);
        }
    }
}

console.log("Standard pathUtils produces:", test(-180, 360));
