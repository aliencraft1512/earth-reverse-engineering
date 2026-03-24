const axios = require('axios');
const fs = require('fs');

const REQUEST_HEADERS = {
  'User-Agent': 'GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)',
  'Accept-Encoding': 'gzip, deflate, gfe',
};

async function testTile() {
    const p = "0020023111223330332";
    const f = "fc39f";
    const versions = [273, 272, 274, 288, 366, 1030, 970, 1007];
    
    for (const v of versions) {
        const url = `https://cmpmap.com/flatfile?db=tm&f1-${p}-i.${v}-${f}`;
        console.log(`Trying v${v}: ${url}`);
        try {
            const res = await axios.get(url, { responseType: 'arraybuffer', headers: REQUEST_HEADERS, timeout: 5000 });
            console.log(`  SUCCESS! Received ${res.data.byteLength} bytes`);
            return;
        } catch (e) {
            console.log(`  Failed: ${e.message}`);
        }
    }
}

testTile();
