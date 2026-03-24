
const fs = require('fs');

function readVarint(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buffer.length) {
    const b = BigInt(buffer[i++]);
    result |= (b & 0x7fn) << shift;
    if ((b & 0x80n) === 0n) return { value: Number(result), next: i };
    shift += 7n;
  }
  return { value: Number(result), next: i, error: 'EOF' };
}

const data = fs.readFileSync('qp_decompressed.bin');
let i = 0;
while (i < 500) {
    const { value: tagKey, next: nTag } = readVarint(data, i);
    const tag = tagKey >> 3;
    const type = tagKey & 7;
    if (type === 0) {
        const { value: val, next: nVal } = readVarint(data, nTag);
        console.log(`Offset ${i}: Tag ${tag} (Varint) = ${val}`);
        i = nVal;
    } else if (type === 2) {
        const { value: len, next: nLen } = readVarint(data, nTag);
        console.log(`Offset ${i}: Tag ${tag} (Length) = ${len} bytes`);
        i = nLen + len;
    } else {
        console.log(`Offset ${i}: Tag ${tag} (Unknown type ${type})`);
        break;
    }
}
