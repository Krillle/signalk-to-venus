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
    this.saveInProgress = false; // Prevent concurrent saves
    this.pendingSaveData = null; // Queue data if save is in progress
    this.lastSaveAttempt = 0; // Track last save attempt
  }

  /**
   * Load history data from persistent storage
   * @returns {Object} Object containing historyData, lastUpdateTime, and energyAccumulators Maps
   */
  async loadHistoryData() {
    try {
      // Wait if a save operation is in progress to avoid reading partial data
      let attempts = 0;
      while (this.saveInProgress && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      
      const data = await fs.readFile(this.filePath, 'utf8');
      
      // Validate JSON before parsing to detect corruption
      const trimmedData = data.trim();
      if (!trimmedData.startsWith('{') || !trimmedData.endsWith('}')) {
        throw new Error('History file appears to be corrupted (invalid JSON structure)');
      }
      
      // Additional validation: check for incomplete data at position 121 area
      if (trimmedData.length < 200 && trimmedData.includes('electrical.batteries')) {
        throw new Error('History file appears to be truncated or corrupted');
      }
      
      const parsed = JSON.parse(trimmedData);
      
      // Convert plain objects back to Maps
      const historyData = new Map();
      const lastUpdateTime = new Map();
      const energyAccumulators = new Map();
      
      if (parsed.historyData) {
        this.logger.debug(`Loading historyData with ${Object.keys(parsed.historyData).length} entries`);
        for (const [key, value] of Object.entries(parsed.historyData)) {
          this.logger.debug(`Loading history entry: ${key}`, value);
          // Skip invalid keys
          if (!key || key === 'undefined' || key === 'null') {
            this.logger.debug(`Skipping invalid history key: ${key}`);
            continue;
          }
          
          // Validate data structure
          if (value && typeof value === 'object') {
            historyData.set(key, value);
            this.logger.debug(`Added to historyData map: ${key}`);
          } else {
            this.logger.debug(`Skipping invalid history value for ${key}:`, value);
          }
        }
      } else {
        this.logger.debug(`No historyData found in parsed file`);
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
      } else if (error.message.includes('JSON') || error.message.includes('position')) {
        // JSON parsing error - likely corrupted file
        this.logger.error(`History file corrupted (${error.message}), backing up and starting fresh`);
        
        // Try to backup the corrupted file for debugging
        try {
          const backupPath = `${this.filePath}.corrupted.${Date.now()}`;
          await fs.rename(this.filePath, backupPath);
          this.logger.debug(`Backed up corrupted history file to ${backupPath}`);
        } catch (backupError) {
          this.logger.error(`Failed to backup corrupted file: ${backupError.message}`);
        }
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
   * Save history data to persistent storage with atomic write and concurrency protection
   * @param {Map} historyData - Battery history data
   * @param {Map} energyAccumulators - Energy accumulation data
   * @param {Map} lastUpdateTime - Last update timestamps
   */
  async saveHistoryData(historyData, energyAccumulators, lastUpdateTime) {
    const now = Date.now();
    
    // Prevent too frequent saves (minimum 1 second apart)
    if (now - this.lastSaveAttempt < 1000) {
      this.logger.debug('Save throttled - too recent, queuing data');
      this.pendingSaveData = { historyData, energyAccumulators, lastUpdateTime };
      return;
    }
    
    // Prevent concurrent saves to avoid file corruption
    if (this.saveInProgress) {
      this.logger.debug('Save already in progress, queuing latest data');
      this.pendingSaveData = { historyData, energyAccumulators, lastUpdateTime };
      return;
    }

    this.saveInProgress = true;
    this.lastSaveAttempt = now;
    
    try {
      await this._performSave(historyData, energyAccumulators, lastUpdateTime);
      
      // If there's pending data, save it too (but only once to avoid loops)
      if (this.pendingSaveData) {
        const pendingData = this.pendingSaveData;
        this.pendingSaveData = null;
        
        // Wait a bit before saving pending data
        await new Promise(resolve => setTimeout(resolve, 100));
        await this._performSave(pendingData.historyData, pendingData.energyAccumulators, pendingData.lastUpdateTime);
      }
      
    } catch (error) {
      this.logger.error(`Failed to save history data: ${error.message}`);
      throw error;
    } finally {
      this.saveInProgress = false;
    }
  }

  /**
   * Internal save method that performs the actual file operations
   * @param {Map} historyData - Battery history data
   * @param {Map} energyAccumulators - Energy accumulation data
   * @param {Map} lastUpdateTime - Last update timestamps
   */
  async _performSave(historyData, energyAccumulators, lastUpdateTime) {
    try {
      // Validate inputs before attempting to save
      if (!historyData || !(historyData instanceof Map)) {
        throw new Error('Invalid historyData - must be a Map');
      }
      if (!energyAccumulators || !(energyAccumulators instanceof Map)) {
        throw new Error('Invalid energyAccumulators - must be a Map');
      }
      if (!lastUpdateTime || !(lastUpdateTime instanceof Map)) {
        throw new Error('Invalid lastUpdateTime - must be a Map');
      }
      
      // Ensure directory exists
      const dir = path.dirname(this.filePath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (dirError) {
        // Directory might already exist, ignore
      }
      
      // Convert Maps to plain objects for JSON serialization, with validation
      const historyObj = {};
      for (const [key, value] of historyData) {
        if (key && key !== 'undefined' && key !== 'null' && value && typeof value === 'object') {
          historyObj[key] = value;
        }
      }
      
      const energyObj = {};
      for (const [key, value] of energyAccumulators) {
        if (key && key !== 'undefined' && key !== 'null' && value && typeof value === 'object') {
          energyObj[key] = value;
        }
      }
      
      const timeObj = {};
      for (const [key, value] of lastUpdateTime) {
        if (key && key !== 'undefined' && key !== 'null' && typeof value === 'number') {
          timeObj[key] = value;
        }
      }
      
      const data = {
        historyData: historyObj,
        energyAccumulators: energyObj,
        lastUpdateTime: timeObj,
        lastSaved: new Date().toISOString()
      };
      
      // Validate data before saving to prevent corruption
      const jsonString = JSON.stringify(data, null, 2);
      if (!jsonString || jsonString.length < 50) {
        throw new Error('Generated JSON string is invalid or too short');
      }
      
      // Validate that the JSON contains expected structure
      if (!jsonString.includes('historyData') || !jsonString.includes('lastSaved')) {
        throw new Error('Generated JSON missing required structure');
      }
      
      // Atomic write: write to temporary file first, then rename
      const tempFilePath = `${this.filePath}.tmp`;
      await fs.writeFile(tempFilePath, jsonString, 'utf8');
      
      // Verify the temporary file was written correctly
      const verification = await fs.readFile(tempFilePath, 'utf8');
      const parsed = JSON.parse(verification); // This will throw if JSON is invalid
      
      // Additional verification - check structure
      if (!parsed.historyData || !parsed.lastSaved) {
        throw new Error('Verification failed - saved data missing required fields');
      }
      
      // If verification passes, rename to final location
      await fs.rename(tempFilePath, this.filePath);
      
      this.logger.debug(`Saved history data for ${historyData.size} devices to ${this.filePath}`);
      
    } catch (error) {
      this.logger.error(`Error saving history data: ${error.message}`);
      
      // Clean up temporary file if it exists
      try {
        await fs.unlink(`${this.filePath}.tmp`);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      
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
