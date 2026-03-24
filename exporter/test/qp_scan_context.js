
const fs = require('fs');
const path = require('path');

function decodeDate(val) {
    const year = (val >> 9) + 1920;
    const month = (val >> 5) & 0x0F;
    const day = val & 0x1F;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function readVarint(buffer, offset) {
    let result = 0;
    let shift = 0;
    let i = offset;
    while (i < buffer.length) {
        const b = buffer[i++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: result >>> 0, next: i };
        shift += 7;
        if (shift > 56) return { value: 0, next: i, error: 'Too long' };
    }
    return { value: 0, next: i, error: 'EOF' };
}

const data = fs.readFileSync(path.join(__dirname, 'qp_decompressed.bin'));

console.log("Scanning qp_decompressed.bin for (Date, iCode) patterns...");

let count = 0;
let lastDate = null;
let lastVersion = null;

for (let i = 0; i < data.length - 10; i++) {
    // Look for Field 1 (wire 2) which is a message containing Date (Field 1, wire 0) and iCode (Field 2, wire 0)
    // 0x0A [len] 0x08 [date_varint] 0x10 [version_varint]
    if (data[i] === 0x0A && data[i + 2] === 0x08) {
        const len = data[i + 1];
        const { value: dateVal, next: afterDate } = readVarint(data, i + 3);
        if (data[afterDate] === 0x10) {
            const { value: versionVal, next: afterVersion } = readVarint(data, afterDate + 1);
            const dateStr = decodeDate(dateVal);
            console.log(`Found: Date=${dateStr} (${dateVal}), iCode=${versionVal} at offset ${i}`);
            count++;
            if (count > 50) {
                console.log("... (stopping after 50 matches)");
                break;
            }
        }
    }
}

console.log(`Total patterns found: ${count}`);
