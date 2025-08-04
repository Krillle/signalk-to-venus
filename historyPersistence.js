import fs from 'fs/promises';
import path from 'path';

/**
 * Handles persistence of battery history data for VRM consumption calculations
 * Provides atomic write operations and periodic saving to prevent data loss
 */
export class HistoryPersistence {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger || { debug: () => {}, error: () => {} };
    this.periodicSaveInterval = null;
    this.saveIntervalMs = 60000; // Save every minute
  }

  /**
   * Load history data from persistent storage
   * @returns {Object} Object containing historyData, lastUpdateTime, and energyAccumulators Maps
   */
  async loadHistoryData() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      
      // Convert plain objects back to Maps
      const historyData = new Map();
      const lastUpdateTime = new Map();
      const energyAccumulators = new Map();
      
      if (parsed.historyData) {
        for (const [key, value] of Object.entries(parsed.historyData)) {
          // Skip invalid keys
          if (!key || key === 'undefined' || key === 'null') {
            this.logger.debug(`Skipping invalid history key: ${key}`);
            continue;
          }
          
          // Validate data structure
          if (value && typeof value === 'object') {
            historyData.set(key, value);
          }
        }
      }
      
      if (parsed.lastUpdateTime) {
        for (const [key, value] of Object.entries(parsed.lastUpdateTime)) {
          if (!key || key === 'undefined' || key === 'null') {
            continue;
          }
          lastUpdateTime.set(key, value);
        }
      }
      
      if (parsed.energyAccumulators) {
        for (const [key, value] of Object.entries(parsed.energyAccumulators)) {
          if (!key || key === 'undefined' || key === 'null') {
            continue;
          }
          energyAccumulators.set(key, value);
        }
      }
      
      this.logger.debug(`Loaded history data for ${historyData.size} devices from ${this.filePath}`);
      
      return {
        historyData,
        lastUpdateTime,
        energyAccumulators
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.logger.debug(`History file ${this.filePath} not found, starting with empty data`);
      } else {
        this.logger.error(`Error loading history data: ${error.message}`);
      }
      
      // Return empty Maps
      return {
        historyData: new Map(),
        lastUpdateTime: new Map(),
        energyAccumulators: new Map()
      };
    }
  }

  /**
   * Save history data to persistent storage with atomic write
   * @param {Map} historyData - Battery history data
   * @param {Map} energyAccumulators - Energy accumulation data
   * @param {Map} lastUpdateTime - Last update timestamps
   */
  async saveHistoryData(historyData, energyAccumulators, lastUpdateTime) {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (dirError) {
        // Directory might already exist, ignore
      }
      
      // Convert Maps to plain objects for JSON serialization
      const data = {
        historyData: Object.fromEntries(historyData),
        energyAccumulators: Object.fromEntries(energyAccumulators),
        lastUpdateTime: Object.fromEntries(lastUpdateTime),
        lastSaved: new Date().toISOString()
      };
      
      // Atomic write: write to temporary file first, then rename
      const tempFilePath = `${this.filePath}.tmp`;
      await fs.writeFile(tempFilePath, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tempFilePath, this.filePath);
      
      this.logger.debug(`Saved history data for ${historyData.size} devices to ${this.filePath}`);
      
    } catch (error) {
      this.logger.error(`Error saving history data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start periodic saving of history data
   * @param {Map} historyData - Battery history data
   * @param {Map} energyAccumulators - Energy accumulation data  
   * @param {Map} lastUpdateTime - Last update timestamps
   */
  startPeriodicSaving(historyData, energyAccumulators, lastUpdateTime) {
    if (this.periodicSaveInterval) {
      clearInterval(this.periodicSaveInterval);
    }
    
    this.periodicSaveInterval = setInterval(async () => {
      try {
        await this.saveHistoryData(historyData, energyAccumulators, lastUpdateTime);
      } catch (error) {
        this.logger.error(`Periodic save failed: ${error.message}`);
      }
    }, this.saveIntervalMs);
    
    this.logger.debug(`Started periodic saving every ${this.saveIntervalMs / 1000} seconds`);
  }

  /**
   * Stop periodic saving
   * @param {Map} historyData - Battery history data
   * @param {Map} energyAccumulators - Energy accumulation data
   * @param {Map} lastUpdateTime - Last update timestamps
   */
  async stopPeriodicSaving(historyData, energyAccumulators, lastUpdateTime) {
    if (this.periodicSaveInterval) {
      clearInterval(this.periodicSaveInterval);
      this.periodicSaveInterval = null;
    }
    
    // Final save before stopping
    try {
      await this.saveHistoryData(historyData, energyAccumulators, lastUpdateTime);
      this.logger.debug('Final save completed before stopping periodic saving');
    } catch (error) {
      this.logger.error(`Final save failed: ${error.message}`);
    }
  }
}
