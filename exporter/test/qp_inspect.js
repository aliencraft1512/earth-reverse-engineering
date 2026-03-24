
const fs = require('fs');

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buffer.length) {
    const b = buffer[i++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
    shift += 7;
    if (shift > 56) throw new Error('Varint too long');
  }
  return { value: result, next: i, error: 'EOF' };
}

const data = fs.readFileSync('qp_decompressed.bin');
let i = 0;
console.log("Dumping first 20 fields of qp_decompressed.bin:");
while (i < data.length && i < 1000) {
    const { value: key, next: afterKey } = readVarint(data, i);
    i = afterKey;
    const field = key >> 3;
    const wireType = key & 7;
    
    if (wireType === 0) {
        const { value, next } = readVarint(data, i);
        console.log(`Field ${field} (Varint): ${value}`);
        i = next;
    } else if (wireType === 2) {
        const { value: length, next: afterLen } = readVarint(data, i);
        console.log(`Field ${field} (Length-delimited): ${length} bytes`);
        i = afterLen + length;
    } else {
        console.log(`Field ${field} (WireType ${wireType})`);
        break;
    }
}
