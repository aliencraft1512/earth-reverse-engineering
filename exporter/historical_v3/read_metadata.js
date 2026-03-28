const fs = require('fs');
const path = require('path');

try {
    const metaPath = path.join(__dirname, '..', 'historical', 'metadata.js');
    console.log("Reading metadata logic from:", metaPath);
    const content = fs.readFileSync(metaPath, 'utf8');
    console.log("SUCCESS:");
    console.log(content.slice(0, 4000));
} catch (e) {
    console.error("FAILED:", e.message);
}
