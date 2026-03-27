const MetadataManager = require('./MetadataManager');
const path = require('path');

async function runDiagnostics() {
    console.log("=== Historical V3 Diagnostics ===");
    const manager = new MetadataManager(__dirname);
    
    try {
        console.log("\n1. Testing Initialization & XOR Key Extraction...");
        await manager.init();
        if (manager.secretKey && manager.secretKey.length === 1016) {
            console.log("SUCCESS: 1016-byte XOR key extracted.");
        } else {
            console.error("FAILURE: Key extraction failed or length is incorrect.");
        }

        console.log("\n2. Testing Metadata Fetch & Decryption (Nicosia Z14)...");
        const lat = 35.1856;
        const lon = 33.3823;
        const z = 14;
        const dynamicPath = manager.latLonToPath(lat, lon, z);
        console.log(`[Diagnostic] Dynamic Path for Nicosia Z${z}: ${dynamicPath}`);
        
        const metadata = await manager.fetchMetadata(dynamicPath);
        
        if (metadata.entries && metadata.entries.length > 0) {
            console.log(`SUCCESS: Found ${metadata.entries.length} historical dates for Nicosia.`);
            const first = metadata.entries[0];
            console.log(`First entry: Date=${first.date}, iCode=${first.iCode}, fToken=${first.fToken}`);
            
            console.log("\n3. Testing Tile Fetch & Decryption (Using Metadata Info)...");
            try {
                // In fetchTile, it will recalculate path from Slippy. 
                // Let's see if it finds it.
                const n = Math.pow(2, z);
                const x = Math.floor((lon + 180) / 360 * n);
                const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
                
                console.log(`[Diagnostic] Attempting tile fetch for ${z}/${x}/${y} (i.${first.iCode})`);
                const tilePath = await manager.fetchTile(z, x, y, first.iCode, first.fToken); 
                console.log(`SUCCESS: Tile fetched and decrypted to ${tilePath}`);
            } catch (e) {
                console.error(`FAILURE: Tile fetch failed: ${e.message}`);
            }
        } else {
            console.error("FAILURE: No metadata found for dynamic path.");
        }

    } catch (e) {
        console.error("\nCRITICAL ERROR during diagnostics:", e);
    }
    
    console.log("\n=== Diagnostics Complete ===");
}

runDiagnostics();
