
const express = require("express");
const path = require("path");
const fs = require("fs-extra");
const cors = require("cors");
const { exec } = require("child_process");

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloaded_files", express.static(path.join(__dirname, "downloaded_files")));

const DL_DIR = path.join(__dirname, "downloaded_files", "obj");

function runCommand(command) {
    return new Promise((resolve, reject) => {
        console.log(`Executing: ${command}`);
        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return reject(error);
            }
            resolve(stdout);
        });
    });
}

app.post("/api/export", async (req, res) => {
    const { lat, lon, zoom = 19 } = req.body;
    if (!lat || !lon) return res.status(400).json({ error: "Lat/Lon required" });

    try {
        console.log(`Exporting Lat: ${lat}, Lon: ${lon}, Zoom: ${zoom}`);
        const octantOutput = await runCommand(`node lat_long_to_octant.js ${lat} ${lon}`);
        const octantMatches = octantOutput.match(/\d{10,24}/g);
        if (!octantMatches) return res.status(500).json({ error: "Octant not found" });

        const octant = octantMatches[octantMatches.length - 1];
        await runCommand(`node dump_obj.js ${octant} ${zoom}`);

        const dirs = fs.readdirSync(DL_DIR);
        const latestDir = dirs
            .map(d => ({ name: d, time: fs.statSync(path.join(DL_DIR, d)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time)[0];

        res.json({
            message: "Success",
            octant,
            dir: latestDir.name,
            downloadUrl: `/downloaded_files/obj/${latestDir.name}/model.obj`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/exports", (req, res) => {
    if (!fs.existsSync(DL_DIR)) return res.json([]);
    const dirs = fs.readdirSync(DL_DIR);
    res.json(dirs.map(d => ({ name: d, url: `/downloaded_files/obj/${d}/model.obj` })));
});

app.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));

