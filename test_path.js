const { latLonToPath } = require('./exporter/historical/pathUtils');

const lat = 35.1856;
const lon = 33.3823;
const z = 15;

console.log(`Nicosia Z${z}: ${latLonToPath(lat, lon, z)}`);
