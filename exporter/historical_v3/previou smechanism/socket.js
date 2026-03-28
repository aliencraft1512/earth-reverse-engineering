

/*
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Hello World!'));

app.listen(port, () => console.log(`App listening on port ${port}`));

*/




"use strict";


const fetch = require('node-fetch');

var http = require('http');
var express = require('express');
var app = express();



var moment = require("moment"); //JavaScript日期处理库，可以用来格式化和解析日期。

var request = require('request'); //Node.js的HTTP客户端库，可以用来发送HTTP请求和处理响应。
var fs = require('fs'); //Node.js的一个内置模块，可以用来读写文件和目录。
var Q = require('q'); //JavaScript的Promise库，可以用来处理异步操作。
var cors = require('cors'); //Node.js的中间件，可以用来处理跨域请求。


const axios = require('axios');
const cheerio = require('cheerio');





const path = require("path");
const crypto = require("crypto");

app.set("trust proxy", true);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  console.log("[REQ]", req.method, req.url, "CT:", req.headers["content-type"], "CL:", req.headers["content-length"]);
  next();
});




var server = http.createServer(app);
// Pass a http.Server instance to the listen method

//var io = require('socket.io').listen(server, { wsEngine: 'ws' });



var io = require('socket.io')(server, {
    cors: {
        origin: function(origin, callback){
            //const allowedOrigins = ["https://cmpmap.com", "https://cmpmap.org"];
			const allowedOrigins = ["http://sharp-lamarr.85-25-46-226.plesk.page/", "https://85-25-46-226/","https://sharp-lamarr.85-25-46-226.plesk.page/undp"];
			
			
			
            if (!origin || allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error("Origin not allowed by CORS"));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    },
    wsEngine: 'ws'
});






const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Listening on", PORT));

// The server should start listening
//server.listen(3000);




app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); // not just GET
    res.header('Access-Control-Allow-Credentials', 'true');
    next();
});




let sockets = []; //messages

let markers = [];




io.on("connection", socket => {
	
	
	
	sockets.push(socket);
	 socket.on('message', function (message) {
        for (var i = 0; i < sockets.length; i++) {
            sockets[i].send(message);
        }
    });
	
	
	
	
  socket.on("disconnect", () => {
    markers = markers.filter(item => item.markerId !== socket.id);
    io.emit("update-markers-on-frontend", markers);
  });



socket.on('end', function (){   //experiment
    socket.disconnect(0);
});



  socket.on("update-marker", data => {
    if (markers.every(item => item.markerId !== socket.id)) {
      markers.push({ ...data, markerId: socket.id });
    } 
	
	else {
      markers = markers.map(item => {
        if (item.markerId === data.markerId) {
          return data;
        }

        return item;
      });
    }

    io.emit("update-markers-on-frontend", markers);
  });
  
  
  
   socket.on( 'new_notification', function( data ) {
    console.log(data.title,data.message);
    io.sockets.emit( 'show_notification', { 
      title: data.title, 
      message: data.message, 
      icon: data.icon, 
	  coordinates: data.coordinates,
	  pagehash : data.pagehash
    });
  });
  
  
  
  
});



// Endpoint to get air quality data
app.get('/airquality', (req, res) => {
    const url = "https://www.airquality.dli.mlsi.gov.cy/all_stations_data_PM";

    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            res.json(data); // Send the data to the client
        })
        .catch(e => {
            console.error('Error fetching air quality data:', e.message);
            res.status(500).send('Error fetching air quality data');
        });
});













app.get('/weather', (req, res) => {
    const weatherurl = "https://dom.org.cy/AWS/OpenData/CyDoM.xml";

    fetch(weatherurl)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.text(); // Get the response as text (XML)
        })
        .then(xmlData => {
            res.type('application/xml').send(xmlData); // Send the XML data as is
        })
        .catch(e => {
            console.error('Error fetching weather data:', e.message);
            res.status(500).send('Error fetching weather data');
        });
});








const xml2js = require('xml2js');
const parser = new xml2js.Parser();
let earthquakeCache = null;
let cacheTimestamp = null;

app.get('/getearthquakes', async (req, res) => {
    const cacheDuration = 10 * 60 * 1000; // Cache for 10 minutes
    if (earthquakeCache && (Date.now() - cacheTimestamp < cacheDuration)) {
        return res.json(earthquakeCache);
    }

    const url = "http://www.gsd-seismology.org.cy/events/feed.rss";
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const text = await response.text();
        parser.parseStringPromise(text).then(result => {
            const items = result.rss.channel[0].item.map(item => ({
                title: item.title[0],
                link: item.link[0],
                description: item.description[0],
                pubDate: item.pubDate[0]
            }));
            earthquakeCache = items;
            cacheTimestamp = Date.now();
            res.json(items);
        });
    } catch (error) {
        console.error('Error fetching earthquake data:', error);
        res.status(500).send('Error fetching earthquake data');
    }
});













/*

 ///να το κανω enable οταν τελειωσω με τις αλλες προτερραιοτητες


const webpush = require('web-push');

// Use the generated VAPID keys
const vapidPublicKey = 'BGELScv4f-pUrw5Lbgdr10K-X5FfGBXdXC6ILyvf_Ew0jfXtGWnNbqfhMVf9wdg30l3zDHM4sUbAnjkv9NescOs';
const vapidPrivateKey = 'hPwN1JEH5sj-MBQqKtk6DZHKn8F42cd4X8YOifTuJH4';

const vapidPublicKeyBase64 = btoa(vapidPublicKey);
const vapidPrivateKeyBase64 = btoa(vapidPrivateKey);

//console.log(vapidPublicKey);
//console.log(vapidPrivateKey);



webpush.setVapidDetails(
  'mailto:astaroth131313@gmail.com', // Replace with your email
  vapidPublicKey,
  vapidPrivateKey
);


// Function to send the notification
const sendNotification = (subscription, dataPayload) => {
  webpush.sendNotification(subscription, dataPayload)
    .catch(error => console.error(error));
};






const bodyParser = require('body-parser');

app.use(bodyParser.json());

const storedSubscriptions = []; // Consider using a database in production


app.post('/api/save-subscription', (req, res) => {
  const subscription = req.body;
  storedSubscriptions.push(subscription); // Save subscription for later use
  res.json({ message: 'Subscription saved.' });
});





app.post('/api/send-notification', (req, res) => {
  const notificationPayload = req.body.payload; // Assuming you send the payload from the frontend or define it here

  storedSubscriptions.forEach(subscription => {
    sendNotification(subscription, JSON.stringify(notificationPayload));
  });

  res.json({ message: 'Notification sent to all subscriptions.' });
});

*/









app.get('/proxy', (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('URL parameter is required');
    }

    // Forward the request and ensure the proper Content-Type is passed
    request(url)
        .on('response', (response) => {
            const contentType = response.headers['content-type'] || 'application/xml';
            res.set('Content-Type', contentType);
        })
        .pipe(res); // Pipe the response directly to the client
});

























app.get('/northfetch-air-quality', async (req, res) => {
    try {
        const url = "http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=433";
		//  const url = "https://api.codetabs.com/v1/proxy/?quest=http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=433";
        const response = await axios.get(url);
        const data = parseAirQualityData(response.data);
        res.json(data);
    } catch (error) {
        console.error('Error fetching air quality data:', error);
        res.status(500).send('Failed to fetch air quality data');
    }
});






function parseAirQualityData(html) {
    const $ = cheerio.load(html);
    const rows = $('table').eq(0).find('tr').toArray(); // Ensures the correct table is targeted
    const data = [];
    let headers = [];
    let date = "";

    rows.forEach((row, index) => {
        const cells = $(row).find('td').toArray();
   if (index === 0) {
            // Extract the date from the first cell and skip it for headers
            date = $(cells[0]).text().trim();
            // Map headers, adjust for specific names like "Dust PM10" to "PM10"
            headers = cells.slice(1).map(cell => {
                let headerText = $(cell).text().trim();
                return headerText === "Dust PM10" ? "PM10" : headerText;  // Replace "Dust PM10" with "PM10"
            });
            return;
        }

        const stationName = $(cells[0]).text().trim();
        const pollutants = {};

        cells.slice(1).forEach((cell, i) => {
            // Map values to pollutant names, skip the first cell as it is the station name
            const pollutantName = headers[i]; // Direct mapping to headers since we skipped the first cell earlier
            const value = $(cell).text().trim();
            pollutants[pollutantName] = value;
        });

        data.push({
            stationName,
            date, // Include the date for each station record
            pollutants
        });
    });

    return data;
}













app.get('/northfetch-air-qualitysecond', async (req, res) => {
    try {
        const url = "http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=433";
        const airQualityResponse = await axios.get(url);
        const airQualityData = parseAirQualityData(airQualityResponse.data);

        // Fetch PM2.5 data for each station concurrently
        const pm25Promises = airQualityData.map(station => fetchPM25DataForStation(station.stationName));
        const pm25Results = await Promise.all(pm25Promises);

        // Combine the PM2.5 data with the existing data
        const combinedData = airQualityData.map((station, index) => ({
            ...station,
            pollutants: {
                ...station.pollutants,
                'PM2.5': pm25Results[index] || '-' // Add PM2.5 data or '-' if not found
            }
        }));

        res.json(combinedData);
    } catch (error) {
        console.error('Error fetching air quality data:', error);
        res.status(500).send('Failed to fetch air quality data');
    }
});

async function fetchPM25DataForStation(stationName) {
    const todayDateFormatted = getTodayDate(); // Assume this function returns date in 'DD.MM.YYYY' format
    const url = stationLocations_for_pm2_5[stationName];

    if (!url) {
        console.error(`No PM2.5 data URL found for station: ${stationName}`);
        return '-';
    }

    try {
        const response = await axios.get(url);
        const html = response.data;
        const $ = cheerio.load(html);
        const rows = $('table tr').toArray();

        let recentNonZeroValue = '-';

        for (let row of rows) {
            const dateCell = $(row).find('td:first-child div').text().trim();
            if (dateCell.includes(todayDateFormatted)) {
                const pm25ValueCell = $(row).find('td:nth-child(2) div').text().trim();
                if (pm25ValueCell === '-' || pm25ValueCell === '0.00') {
                    continue; // Skip invalid values
                }
                const pm25Value = parseFloat(pm25ValueCell);
                if (!isNaN(pm25Value) && pm25Value > 0) {
                    recentNonZeroValue = pm25Value; // Update the most recent non-zero value
                }
            }
        }

        // Return the most recent non-zero value or '-' if not found
        return recentNonZeroValue;
    } catch (error) {
        console.error(`Error fetching PM2.5 data for ${stationName}:`, error);
        return '-';
    }
}

function getTodayDate() {
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0'); // January is 0!
    const year = today.getFullYear();

    return `${day}.${month}.${year}`;
}

const stationLocations_for_pm2_5 = {
    "Famagusta": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=269`,
    "Kyrenia": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=188`,
    "Nicosia_New_0011": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=131`,
    "Alevkayasi": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=347`,
    "Teknecik_1": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=577`,
    "Kalecik": `http://95.0.174.12/phpturcyp3/show_graph.php?graph_id=715`,
};















app.get('/fetchWindData', async (req, res) => {
	
	
	
    const baseUrl = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';

    async function getValidData(targetMoment) {
        const allowedHours = [0, 6, 12, 18];
        const maxAttempts = allowedHours.length * 2;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let adjustedMoment;

            if (attempt < allowedHours.length) {
                const futureHour = allowedHours[attempt];
                adjustedMoment = targetMoment.clone().hour(futureHour).minute(0).second(0);
                if (adjustedMoment.isBefore(targetMoment)) {
                    adjustedMoment.add(1, 'day');
                }
            } else {
                const pastHour = allowedHours[attempt - allowedHours.length];
                adjustedMoment = targetMoment.clone().hour(pastHour).minute(0).second(0);
                if (adjustedMoment.isAfter(targetMoment)) {
                    adjustedMoment.subtract(1, 'day');
                }
            }

            const params = new URLSearchParams({
                file: `gfs.t${adjustedMoment.format('HH')}z.pgrb2.1p00.f000`,
                lev_10_m_above_ground: 'on',
                lev_surface: 'on',
                var_TMP: 'on',
                var_UGRD: 'on',
                var_VGRD: 'on',
                leftlon: 0,
                rightlon: 360,
                toplat: 90,
                bottomlat: -90,
                dir: `/gfs.${adjustedMoment.format('YYYYMMDD')}/${adjustedMoment.format('HH')}/atmos`
            });

            try {
                console.log(`Attempt ${attempt + 1}: Fetching data for ${adjustedMoment.format('YYYY-MM-DD HH:mm:ss')}...`);

                const response = await axios.get(`${baseUrl}?${params.toString()}`, {
                    responseType: 'arraybuffer'
                });

                if (response.status === 200) {
                    console.log(`Data found for ${adjustedMoment.format('YYYY-MM-DD HH:mm:ss')}`);
                    return {
                        buffer: response.data,
                        adjustedMoment,
                        type: attempt < allowedHours.length ? 'forecast' : 'archive'
                    };
                } else if (response.status === 404) {
                    console.warn(`Data not found for ${adjustedMoment.format('YYYY-MM-DD HH:mm:ss')}, status: 404`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                } else {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
            } catch (error) {
                console.error(`Attempt ${attempt + 1} failed:`, error);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        throw new Error('No valid data found within the available hours.');
    }

    try {
        const targetMoment = moment().utc();
        const { buffer, adjustedMoment, type } = await getValidData(targetMoment);

        const dataType = type === 'forecast' ? 'Forecast' : 'Archive';
        const formattedDate = adjustedMoment.format('YYYY-MM-DD HH:mm:ss');

        console.log(`Fetched ${dataType} data for ${formattedDate}`);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="data_${formattedDate}.grb2"`);
        res.send(Buffer.from(buffer));
    } catch (error) {
        console.error('Fetch error:', error);
        res.status(500).json({ error: `Fetch error: ${error.message}` });
    }
});











/*
app.get('/proxy', (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('URL parameter is required');
    }
    request(url).pipe(res);
});
*/

app.get('/proxy', (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('URL parameter is required');
    }

    // Forward the request and ensure the proper Content-Type is passed
    request(url)
        .on('response', (response) => {
            const contentType = response.headers['content-type'] || 'application/xml';
            res.set('Content-Type', contentType);
        })
        .pipe(res); // Pipe the response directly to the client
});



/*

const urls = {
    modis: {
        '1': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_24h.csv',
        '2': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_48h.csv',
        '3': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv'
    },
    noaa21: {
        '1': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv',
        '2': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_48h.csv',
        '3': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv'
    },
    suomiNPP: {
        '1': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv',
        '2': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_48h.csv',
        '3': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv'
    },
    noaa20: {
        '1': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv',
        '2': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_48h.csv',
        '3': 'https://sharp-lamarr.85-25-46-226.plesk.page/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv'
    }
};

*/
const urls = {
    modis: {
        '1': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_24h.csv',
        '2': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_48h.csv',
        '3': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Europe_7d.csv'
    },
    noaa21: {
        '1': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv',
        '2': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_48h.csv',
        '3': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv'
    },
    suomiNPP: {
        '1': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv',
        '2': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_48h.csv',
        '3': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv'
    },
    noaa20: {
        '1': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv',
        '2': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_48h.csv',
        '3': '/proxy?url=https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv'
    }
};





















app.get('/data/:satellite/:timeRange', async (req, res) => {
    const { satellite, timeRange } = req.params;
    const url = urls[satellite][timeRange];

    if (!url) {
        return res.status(404).json({ error: 'Invalid satellite or time range' });
    }

    try {
        const response = await axios.get(url);
        res.send(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch data' });
    }
});



















function getCurrentDate() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are zero-based
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

app.get('/wind-data', (req, res) => {
    const currentDate = getCurrentDate();
    const windcopernicusUrl = `https://aerosol-alerts.atmosphere.copernicus.eu/data/json/wind/2024/${currentDate}.json`;

    console.log(`Sending URL: ${windcopernicusUrl}`);
    res.json({ url: windcopernicusUrl });
});





































app.get("/health", (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    cacheDir: CACHE_DIR,
    hasSecretKey: !!secretKey,
    now: new Date().toISOString(),
  });
});



const ZeroTileGeoSize = 360;
const ValidBoundRc = [-180.0, 180.0, 180.0, -180.0];

const CACHE_DIR = path.join(__dirname, "tile_cache");
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days
const AXIOS_TIMEOUT_MS = 15000;



// =====================
// CACHE DIR
// =====================
try {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log("[BOOT] cache dir OK");
} catch (e) {
  console.error("[BOOT][FATAL] cannot create cache dir:", e.message);
}

// =====================
// SECRET KEY
// =====================
let secretKey = null;
try {
  secretKey = fs.readFileSync(path.join(__dirname, "dbRoot.v5"));
  console.log("[BOOT] dbRoot.v5 loaded bytes:", secretKey.length);
} catch (e) {
  console.error("[BOOT][DISABLED] dbRoot.v5 missing/unreadable:", e.message);
  secretKey = null;
}

// =====================
// DATE MAP
// =====================
const dateVersionMapping = {
  "2008-04-23": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.10",  hex_code: "fb097" },
  "2008-07-09": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.97",  hex_code: "fb0e9" },
  "2010-07-02": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fb4e2" },
  "2011-06-20": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fb6d4" },
  "2012-07-29": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fb8fd" },
  "2012-12-31": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fba9d" },
  "2013-04-29": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fba9d" },
  "2013-10-24": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.115", hex_code: "fbb58" },
  "2013-10-30": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbb5e" },
  "2014-03-21": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbc75" },
  "2014-10-07": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbd47" },
  "2015-01-24": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbe38" },
  "2015-03-10": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbe6a" },
  "2015-03-22": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbe76" },
  "2015-04-05": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.281", hex_code: "fbe85" },
  "2015-04-13": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fbe8d" },
  "2016-04-05": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.152", hex_code: "fc085" },
  "2016-06-07": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc0c7" },
  "2016-07-24": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc09b" },
  "2016-09-28": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc13c" },
  "2016-11-24": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc178" },
  "2017-04-11": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc28b" },
  "2018-04-06": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc486" },
  "2018-04-16": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc490" },
  "2018-05-05": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc4a5" },
  "2019-06-23": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc6d7" },
  "2019-08-10": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc70a" },
  "2019-08-13": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc70d" },
  "2019-08-15": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc70f" },
  "2019-08-26": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc71a" },
  "2019-12-02": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc782" },
  "2020-04-13": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc88d" },
  "2020-05-21": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.288", hex_code: "fc8b5" },
  "2020-06-09": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.272", hex_code: "fc8c9" },
  "2020-10-16": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.271", hex_code: "fc950" },
  "2022-01-09": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.299", hex_code: "fcd21" },
  "2022-06-11": { base_url: "https://khmdb.google.com/flatfile?db=tm", version: "i.346", hex_code: "fcccb" },

  // empty hex_code -> disabled
  "2023-05-14": { base_url: "https://kh.google.com/flatfile", version: "i.970",  hex_code: "" },
  "2024-07-16": { base_url: "https://kh.google.com/flatfile", version: "i.1007", hex_code: "" },
};

// =====================
// HELPERS
// =====================
function decryptTile(buffer) {
  if (!secretKey) throw new Error("secretKey not loaded");
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const out = Buffer.alloc(buf.length);

  let j = 16;
  for (let i = 0; i < buf.length; i++) {
    const keyChar = secretKey[(j + 8) % secretKey.length];
    out[i] = buf[i] ^ keyChar;
    j++;
    if (j % 8 === 0) j += 16;
    if (j >= 1016) j = (j + 8) % 24;
  }
  return out;
}

function getTileGeoSize(nlevelIndex) {
  return ZeroTileGeoSize / Math.pow(2, nlevelIndex);
}

function getRowColInfoChar(rowIndex, colIndex) {
  const r = rowIndex % 2;
  const c = colIndex % 2;
  if (r > 0 && c > 0) return "2";
  if (r > 0 && c === 0) return "3";
  if (r === 0 && c === 0) return "0";
  return "1";
}

function getRowColInfoStr(lat, lon, nLevel) {
  let str = "";
  for (let i = 0; i <= nLevel; i++) {
    const size = getTileGeoSize(i);
    const col = Math.floor((lon - ValidBoundRc[0]) / size);
    const row = Math.floor((lat - ValidBoundRc[3]) / size);
    str += getRowColInfoChar(row, col);
  }
  return str;
}

async function saveTileToCacheRaw(buffer, cachePath) {
  // decrypted bytes should already represent a JPEG
  await fs.promises.writeFile(cachePath, buffer);
}

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

// =====================
// CACHE CLEANUP
// =====================
function clearOldCache() {
  const now = Date.now();
  try {
    const files = fs.readdirSync(CACHE_DIR);
    let deleted = 0;

    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > CACHE_DURATION) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) {
        console.log("[CACHE] stat/unlink fail:", file, e.message);
      }
    }

    console.log("[CACHE] cleanup OK deleted:", deleted);
  } catch (e) {
    console.log("[CACHE] cleanup fail:", e.message);
  }
}
setInterval(clearOldCache, 24 * 60 * 60 * 1000);

// =====================
// ROUTES
// =====================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    node: process.version,
    cacheDir: CACHE_DIR,
    hasSecretKey: !!secretKey,
    now: new Date().toISOString(),
  });
});

// serve cached tiles
app.use("/tile_cache", express.static(CACHE_DIR, {
  maxAge: "30d",
  setHeaders(res) {
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=2592000");
  }
}));

app.post("/tiles", async (req, res) => {
  const t0 = Date.now();
  console.log("[/tiles] body:", JSON.stringify(req.body || {}).slice(0, 500));

  try {
    if (!secretKey) return res.status(500).json({ error: "dbRoot.v5 missing => historical disabled" });

    const { date, bounds, zoom } = req.body || {};
    if (!date || !bounds || typeof zoom !== "number") {
      return res.status(400).json({ error: "Missing date/bounds/zoom" });
    }

    const dateDetails = dateVersionMapping[date];
    if (!dateDetails) return res.status(400).json({ error: "Invalid date" });

    const { base_url, version, hex_code } = dateDetails;
    if (!hex_code) return res.status(400).json({ error: "Date unsupported (empty hex_code)" });

    const { north, south, east, west } = bounds;

    const tileSize = getTileGeoSize(zoom);
    const nColLeft = Math.floor((west - ValidBoundRc[0]) / tileSize);
    const nColRight = Math.floor((east - ValidBoundRc[0]) / tileSize);
    const nRowBottom = Math.floor((south - ValidBoundRc[3]) / tileSize);
    const nRowTop = Math.floor((north - ValidBoundRc[3]) / tileSize);

    console.log("[/tiles] computed grid:", { nColLeft, nColRight, nRowBottom, nRowTop, tileSize });

    const tileUrls = [];
    let fetchCount = 0;
    let cacheHit = 0;

    for (let row = nRowBottom; row <= nRowTop; row++) {
      for (let col = nColLeft; col <= nColRight; col++) {
        const rowColInfoStr = getRowColInfoStr(
          row * tileSize + ValidBoundRc[3],
          col * tileSize + ValidBoundRc[0],
          zoom
        );

        const tileUrl = `${base_url}&f1-${rowColInfoStr}-${version}-${hex_code}`;
        const cacheName = md5(tileUrl) + ".jpg";
        const cachePath = path.join(CACHE_DIR, cacheName);

        const tileSouth = row * tileSize + ValidBoundRc[3];
        const tileWest = col * tileSize + ValidBoundRc[0];
        const tileNorth = tileSouth + tileSize;
        const tileEast = tileWest + tileSize;

        const publicUrl = `${req.protocol}://${req.get("host")}/tile_cache/${cacheName}`;
      console.log("publicUrl",publicUrl)
        if (fs.existsSync(cachePath)) {
          cacheHit++;
          tileUrls.push({
            url: publicUrl,
            bounds: { north: tileNorth, south: tileSouth, east: tileEast, west: tileWest },
            cached: true
          });
          continue;
        }

        try {
          fetchCount++;
          const r = await axios.get(tileUrl, {
            responseType: "arraybuffer",
            timeout: AXIOS_TIMEOUT_MS,
            validateStatus: s => s === 200 || s === 404,
            headers: {
              "User-Agent": "GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)",
              "Accept-Encoding": "gzip, deflate, gfe",
            }
          });

          if (r.status === 404) continue;

          const decrypted = decryptTile(r.data);
          await saveTileToCacheRaw(decrypted, cachePath);

          tileUrls.push({
            url: publicUrl,
            bounds: { north: tileNorth, south: tileSouth, east: tileEast, west: tileWest },
            cached: false
          });

        } catch (e) {
          console.log("[/tiles] fetch fail:", e.message);
        }
      }
    }

    console.log("[/tiles] done ms:", Date.now() - t0, "tiles:", tileUrls.length, "cacheHit:", cacheHit, "fetched:", fetchCount);
    return res.json(tileUrls);

  } catch (e) {
    console.error("[/tiles][FATAL]", e.stack || e.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Cache for results
const availableDatesCache = new Map();

app.post("/available-dates", async (req, res) => {
  const t0 = Date.now();
  console.log("[/available-dates] body:", JSON.stringify(req.body || {}).slice(0, 500));

  try {
    const { bounds, zoom } = req.body || {};
    if (!bounds || typeof zoom !== "number") {
      return res.status(400).json({ error: "Missing bounds/zoom" });
    }

    const cacheKey = `${bounds.north},${bounds.south},${bounds.east},${bounds.west},${zoom}`;
    if (availableDatesCache.has(cacheKey)) {
      console.log("[/available-dates] cache hit");
      return res.json({ availableDates: availableDatesCache.get(cacheKey) });
    }

    const tileSize = getTileGeoSize(zoom);
    const nColLeft = Math.floor((bounds.west - ValidBoundRc[0]) / tileSize);
    const nColRight = Math.floor((bounds.east - ValidBoundRc[0]) / tileSize);
    const nRowBottom = Math.floor((bounds.south - ValidBoundRc[3]) / tileSize);
    const nRowTop = Math.floor((bounds.north - ValidBoundRc[3]) / tileSize);

    const nColMid = Math.floor((nColLeft + nColRight) / 2);
    const nRowMid = Math.floor((nRowBottom + nRowTop) / 2);

    const tilesToCheck = [
      { row: nRowMid, col: nColMid },
      { row: nRowMid - 1, col: nColMid },
      { row: nRowMid + 1, col: nColMid },
      { row: nRowMid, col: nColMid - 1 },
      { row: nRowMid, col: nColMid + 1 },
    ];

    console.log("[/available-dates] tilesToCheck:", tilesToCheck);

    const dateChecks = Object.entries(dateVersionMapping).map(async ([date, details]) => {
      const { base_url, version, hex_code } = details;
      if (!hex_code) return null;

      const checks = tilesToCheck.map(({ row, col }) => {
        const rowColInfoStr = getRowColInfoStr(
          row * tileSize + ValidBoundRc[3],
          col * tileSize + ValidBoundRc[0],
          zoom
        );

        const tileUrl = `${base_url}&f1-${rowColInfoStr}-${version}-${hex_code}`;

        return axios.get(tileUrl, {
          timeout: 10000,
          validateStatus: s => s === 200 || s === 404,
          headers: {
            "User-Agent": "GoogleEarth/7.3.6.9796(Windows;Microsoft Windows (6.2.9200.0);el;kml:2.2;client:Pro;type:default)",
            "Accept-Encoding": "gzip, deflate, gfe",
          }
        }).then(r => r.status === 200).catch(() => false);
      });

      const results = await Promise.all(checks);
      return results.includes(true) ? date : null;
    });

    const availableDates = (await Promise.all(dateChecks)).filter(Boolean);
    availableDatesCache.set(cacheKey, availableDates);

    console.log("[/available-dates] done ms:", Date.now() - t0, "count:", availableDates.length);
    return res.json({ availableDates });

  } catch (e) {
    console.error("[/available-dates][FATAL]", e.stack || e.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});











app.get('/flatfile', (req, res) => {
    const targetUrl = `https://khmdb.google.com${req.originalUrl}`;

    request(targetUrl)
        .on('response', (response) => {
            if (response.headers['content-type']) {
                res.set('Content-Type', response.headers['content-type']);
            }
        })
        .on('error', (err) => {
            console.error('flatfile proxy error:', err.message);
            if (!res.headersSent) {
                res.status(502).send('Upstream request failed');
            }
        })
        .pipe(res);
});