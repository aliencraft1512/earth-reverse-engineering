
const axios = require('axios');
const fs = require('fs');

async function testFetch() {
    const url = "https://cmpmap.com/flatfile?dbroot.v5";
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });
        console.log("Success! Received", response.data.length, "bytes.");
        fs.writeFileSync('dbRoot_test.v5', Buffer.from(response.data));
    } catch (e) {
        console.log("Failed:", e.message);
        if (e.response) {
            console.log("Status:", e.response.status);
            console.log("Data:", Buffer.from(e.response.data).toString());
        }
    }
}

testFetch();
