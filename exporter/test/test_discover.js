const axios = require('axios');
const data = {
    bounds: {
        ne: { lat: 35.13, lon: 33.43 },
        sw: { lat: 35.12, lon: 33.42 }
    }
};
console.log("Sending discovery request (this might take a while)...");
axios.post('http://localhost:3001/discover', data, { timeout: 60000 })
    .then(res => {
        if (res.data.length === 0) {
            console.log("No dates found.");
        } else {
            console.log(`Found ${res.data.length} dates:`);
            console.log(JSON.stringify(res.data, null, 2));
        }
    })
    .catch(err => console.error("Request failed:", err.message));
