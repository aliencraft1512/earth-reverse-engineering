
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

function decodeDate(val) {
    let year = val >> 9;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    if (year < 200) year += 1920;
    if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseProtobuf(buffer, offset = 0, limit = buffer.length) {
    const fields = [];
    let i = offset;
    while (i < limit) {
        try {
            const { value: key, next: afterKey, error } = readVarint(buffer, i);
            if (error) break;
            i = afterKey;
            const field = key >> 3;
            const wireType = key & 7;

            if (wireType === 0) {
                const { value, next } = readVarint(buffer, i);
                fields.push({ field, wireType, value });
                i = next;
            } else if (wireType === 2) {
                const { value: length, next: afterLen } = readVarint(buffer, i);
                i = afterLen;
                const value = buffer.subarray(i, i + length);
                fields.push({ field, wireType, length, value });
                i += length;
            } else if (wireType === 5) {
                i += 4;
            } else if (wireType === 1) {
                i += 8;
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return fields;
}

function deepSearch(buffer, path = "") {
    const fields = parseProtobuf(buffer);
    fields.forEach((f, idx) => {
        const currentPath = path ? `${path}.${f.field}` : `${f.field}`;
        if (f.wireType === 0) {
            const date = decodeDate(f.value);
            if (date) {
                console.log(`[DATE FOUND] Path: ${currentPath}, Value: ${f.value}, Date: ${date}`);
            }
        } else if (f.wireType === 2) {
            deepSearch(f.value, currentPath);
        }
    });
}

const data = fs.readFileSync('qp_decompressed.bin');
console.log("Deep searching qp_decompressed.bin for dates...");
deepSearch(data);
