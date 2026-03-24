
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
    const year = val >> 9;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseProtobuf(buffer, offset = 0, limit = buffer.length) {
    const fields = [];
    let i = offset;
    while (i < limit) {
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
            fields.push({ field, wireType, value: buffer.readFloatLE(i) });
            i += 4;
        } else if (wireType === 1) {
            fields.push({ field, wireType, value: buffer.readDoubleLE(i) });
            i += 8;
        } else {
            // Skip unknown wire types if possible, or break
            break;
        }
    }
    return fields;
}

const data = fs.readFileSync('qp_decompressed.bin');
const rootFields = parseProtobuf(data);

console.log("Root Fields:");
rootFields.forEach(f => {
    console.log(`Field ${f.field} (wire ${f.wireType}): ${f.length !== undefined ? 'len ' + f.length : f.value}`);
    if (f.wireType === 2) {
        try {
            const sub = parseProtobuf(f.value);
            if (sub.length > 0) {
                console.log(`  [Sub-fields for Field ${f.field}]`);
                sub.forEach(sf => {
                    let extra = "";
                    if (sf.field === 1 && sf.wireType === 0 && sf.value > 1000000) extra = `(Possible Date: ${decodeDate(sf.value)})`;
                    console.log(`    Field ${sf.field} (wire ${sf.wireType}): ${sf.value} ${extra}`);
                    
                    if (sf.wireType === 2) {
                         try {
                            const sub2 = parseProtobuf(sf.value);
                            if (sub2.length > 0) {
                                console.log(`      [Sub-sub-fields for Field ${sf.field}]`);
                                sub2.forEach(ssf => {
                                    let extra2 = "";
                                    if (ssf.field === 1 && ssf.wireType === 0 && ssf.value > 1000000) extra2 = `(Possible Date: ${decodeDate(ssf.value)})`;
                                    console.log(`        Field ${ssf.field} (wire ${ssf.wireType}): ${ssf.value} ${extra2}`);
                                });
                            }
                         } catch(e) {}
                    }
                });
            }
        } catch(e) {}
    }
});
