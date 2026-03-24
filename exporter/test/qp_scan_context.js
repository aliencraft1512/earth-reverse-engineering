
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

function decodeDate(val) {
    let year = val >> 9;
    if (year < 200) year += 1920;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const data = fs.readFileSync('qp_decompressed.bin');
let i = 0;
while (i < data.length - 20) {
    if (data[i] === 0x08) {
        const { value: v1, next: n1 } = readVarint(data, i + 1);
        const date = decodeDate(v1);
        if (date === '2025-07-02') {
            console.log(`Found 2025-07-02 at offset ${i}`);
            // Print next 20 bytes
            console.log('Context:', data.slice(i, i + 30).toString('hex'));
            
            // Scan next fields
            let j = n1;
            for(let k=0; k<5; k++) {
                const { value: tagKey, next: nTag } = readVarint(data, j);
                const tag = tagKey >> 3;
                const type = tagKey & 7;
                if (type === 0) {
                    const { value: val, next: nVal } = readVarint(data, nTag);
                    console.log(`  Tag ${tag}: ${val}`);
                    j = nVal;
                } else if (type === 2) {
                    const { value: len, next: nLen } = readVarint(data, nTag);
                    console.log(`  Tag ${tag}: [Length ${len}]`);
                    j = nLen + len;
                } else {
                    break;
                }
            }
        }
    }
    i++;
}
