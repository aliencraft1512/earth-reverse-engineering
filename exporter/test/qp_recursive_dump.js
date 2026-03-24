
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

function dumpProtobuf(buffer, start = 0, end = buffer.length, prefix = '') {
    let i = start;
    while (i < end) {
        try {
            const { value: tagKey, next: nTag } = readVarint(buffer, i);
            const tag = tagKey >> 3;
            const type = tagKey & 7;
            
            if (type === 0) {
                const { value: val, next: nVal } = readVarint(buffer, nTag);
                const date = decodeDate(val);
                console.log(`${prefix}Tag ${tag} (Varint) = ${val} ${date ? '[' + date + ']' : ''}`);
                i = nVal;
            } else if (type === 2) {
                const { value: len, next: nLen } = readVarint(buffer, nTag);
                console.log(`${prefix}Tag ${tag} (Length) = ${len} bytes`);
                // Heuristic for nested protobuf
                const sub = buffer.slice(nLen, nLen + len);
                if (len > 2 && (sub[0] >> 3) > 0 && (sub[0] >> 3) < 30) {
                    dumpProtobuf(buffer, nLen, nLen + len, prefix + '  ');
                }
                i = nLen + len;
            } else if (type === 3) {
                console.log(`${prefix}Tag ${tag} (StartGroup)`);
                i = nTag;
            } else if (type === 4) {
                console.log(`${prefix}Tag ${tag} (EndGroup)`);
                i = nTag;
            } else if (type === 1) {
                console.log(`${prefix}Tag ${tag} (64-bit)`);
                i = nTag + 8;
            } else if (type === 5) {
                console.log(`${prefix}Tag ${tag} (32-bit)`);
                i = nTag + 4;
            } else {
                i++;
            }
        } catch (e) { i++; }
    }
}

const data = fs.readFileSync('qp_decompressed.bin');
dumpProtobuf(data);
