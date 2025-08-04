import fs from 'fs/promises';
import path from 'path';

export class HistoryPersistence {
  constructor(dataPath = './battery-history.json', logger = null) {
    this.dataPath = dataPath;
    this.logger = logger || { debug: () => {}, error: () => {} };
    this.saveInterval = 300000; // Save every 5 minutes
    this.saveTimer = null;
    this.pendingSave = false;
  }

  /**
   * Load history data from persistent storage
   */
  async loadHistoryData() {
    try {
      const data = await fs.readFile(this.dataPath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert back to Maps
      const historyData = new Map();
      const energyAccumulators = new Map();
      const lastUpdateTime = new Map();
      
      if (parsed.historyData) {
        for (const [key, value] of Object.entries(parsed.historyData)) {
          historyData.set(key, value);
        }
      }
      
      if (parsed.energyAccumulators) {
        for (const [key, value] of Object.entries(parsed.energyAccumulators)) {
          energyAccumulators.set(key, value);
        }
      }
      
      if (parsed.lastUpdateTime) {
        for (const [key, value] of Object.entries(parsed.lastUpdateTime)) {
          lastUpdateTime.set(key, value);
        }
      }
      
      this.logger.debug(`Loaded history data for ${historyData.size} devices`);
      
      return {
        historyData,
        energyAccumulators,
        lastUpdateTime
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.debug('No existing history data found, starting fresh');
      } else {
        this.logger.error(`Error loading history data: ${error.message}`);
      }
      
      // Return empty Maps
      return {
        historyData: new Map(),
        energyAccumulators: new Map(),
        lastUpdateTime: new Map()
      };
    }
  }

  /**
   * Save history data to persistent storage
   */
  async saveHistoryData(historyData, energyAccumulators, lastUpdateTime) {
    if (this.pendingSave) {
      return; // Save already in progress
    }
    
    this.pendingSave = true;
    
    try {
      // Convert Maps to plain objects for JSON serialization
      const dataToSave = {
        historyData: Object.fromEntries(historyData),
        energyAccumulators: Object.fromEntries(energyAccumulators),
        lastUpdateTime: Object.fromEntries(lastUpdateTime),
        lastSaved: new Date().toISOString()
      };
      
      // Write to temp file first, then rename (atomic operation)
      const tempPath = this.dataPath + '.tmp';
      await fs.writeFile(tempPath, JSON.stringify(dataToSave, null, 2));
      await fs.rename(tempPath, this.dataPath);
      
      this.logger.debug(`Saved history data for ${historyData.size} devices`);
      
    } catch (error) {
      this.logger.error(`Error saving history data: ${error.message}`);
    } finally {
      this.pendingSave = false;
    }
  }

  /**
   * Start periodic saving
   */
  startPeriodicSaving(historyData, energyAccumulators, lastUpdateTime) {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    
    this.saveTimer = setInterval(async () => {
      await this.saveHistoryData(historyData, energyAccumulators, lastUpdateTime);
    }, this.saveInterval);
  }

  /**
   * Stop periodic saving and do final save
   */
  async stopPeriodicSaving(historyData, energyAccumulators, lastUpdateTime) {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    
    // Final save
    await this.saveHistoryData(historyData, energyAccumulators, lastUpdateTime);
  }
}
