const fs = require('fs');
const path = require('path');

try {
    const catalogPath = path.join(__dirname, '..', 'historical', 'catalog.js');
    console.log("Reading catalog from:", catalogPath);
    const content = fs.readFileSync(catalogPath, 'utf8');
    console.log("SUCCESS:");
    console.log(content.slice(0, 2000));
} catch (e) {
    console.error("FAILED:", e.message);
}
