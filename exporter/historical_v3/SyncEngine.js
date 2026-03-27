const MetadataManager = require('./MetadataManager');
const path = require('path');
const fs = require('fs-extra');

class SyncEngine {
    constructor(workDir) {
        this.workDir = workDir;
        this.manager = new MetadataManager(workDir);
        this.indexPath = path.join(workDir, 'public', 'world_index.json');
        this.isSyncing = false;
    }

    async startBackgroundSync() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        
        console.log("[Sync] Starting background global discovery...");
        try {
            await this.manager.init();
            const newData = await this.crawlWorldParallel(4); // Z4 coverage
            await this.mergeAndSave(newData);
        } catch (e) {
            console.error("[Sync] Background sync failed:", e.message);
        } finally {
            this.isSyncing = false;
        }
    }

    async crawlWorldParallel(maxZoom) {
        const queue = ["0", "1"];
        const results = {}; // Date -> Set of pathCodes
        const concurrency = 15; // Balanced speed vs blocking risk
        
        let processedCount = 0;
        const allPaths = [];
        
        // Generate all paths to Z4 first for easy parallel mapping
        const generatePaths = (p) => {
            allPaths.push(p);
            if (p.length <= maxZoom) {
                for (let i = 0; i < 4; i++) generatePaths(p + i);
            }
        };
        queue.forEach(generatePaths);

        console.log(`[Sync] Crawling ${allPaths.length} global quadrants...`);

        // Use the manager's logic to fetch in parallel
        const { mapWithConcurrency } = require('../historical/catalog');
        
        await mapWithConcurrency(allPaths, concurrency, async (pathCode) => {
            try {
                const metadata = await this.manager.fetchMetadata(pathCode);
                if (metadata.entries) {
                    metadata.entries.forEach(e => {
                        if (!results[e.date]) results[e.date] = new Set();
                        results[e.date].add(pathCode);
                    });
                }
                processedCount++;
                if (processedCount % 50 === 0) {
                    console.log(`[Sync] Progress: ${Math.round((processedCount/allPaths.length)*100)}%`);
                }
            } catch (e) {
                // Silently skip failed packets in background
            }
        });

        // Convert Sets to Arrays for JSON
        const final = {};
        for (const date in results) {
            final[date] = [...results[date]];
        }
        return final;
    }

    async mergeAndSave(newData) {
        let existing = { dates: {} };
        if (fs.existsSync(this.indexPath)) {
            existing = fs.readJsonSync(this.indexPath);
        }

        let newEntriesFound = 0;
        for (const date in newData) {
            if (!existing.dates[date]) {
                existing.dates[date] = newData[date];
                newEntriesFound++;
            } else {
                // Merge paths for existing dates
                const combined = new Set([...existing.dates[date], ...newData[date]]);
                existing.dates[date] = [...combined];
            }
        }

        existing.lastUpdated = new Date().toISOString();
        existing.zoomLevel = 4;
        
        fs.writeJsonSync(this.indexPath, existing);
        console.log(`[Sync] Update complete. Found ${newEntriesFound} new imagery dates.`);
    }
}

module.exports = SyncEngine;
