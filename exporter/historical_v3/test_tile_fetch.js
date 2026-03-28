const axios = require('axios');
const fs = require('fs');

async function testTile() {
    try {
        console.log("Testing tile fetch...");
        // Nicosia Z14 tile: 14/9711/6479, Date: 2025-07-02, iCode: 362, fToken: fd2e2
        const url = "http://localhost:3003/api/tile/14/9711/6479?iCode=362&fToken=fd2e2";
        const res = await axios.get(url, { responseType: 'arraybuffer' });
        console.log("Status:", res.status);
        console.log("Content-Type:", res.headers['content-type']);
        console.log("Length:", res.data.length);
        
        if (res.data.length > 0) {
            fs.writeFileSync('test_tile_out.jpg', res.data);
            console.log("Tile saved to test_tile_out.jpg");
            // Check first few bytes for JPEG magic number FF D8 FF
            const magic = res.data.slice(0, 3).toString('hex');
            console.log("Magic Number:", magic);
            if (magic === 'ffd8ff') {
                console.log("SUCCESS: Valid JPEG magic number.");
            } else {
                console.log("FAILURE: Not a valid JPEG.");
            }
        }
    } catch (e) {
        console.error("Test failed:", e.message);
        if (e.response) {
            console.error("Server responded with:", e.response.data.toString());
        }
    }
}

testTile();
