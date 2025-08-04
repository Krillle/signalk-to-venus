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
      
      // Convert back to Maps and validate values
      const historyData = new Map();
      const energyAccumulators = new Map();
      const lastUpdateTime = new Map();
      
      if (parsed.historyData) {
        for (const [key, value] of Object.entries(parsed.historyData)) {
          // Skip undefined, null, or empty keys
          if (!key || key === 'undefined' || key === 'null') {
            this.logger.debug(`Skipping invalid history key during load: ${key}`);
            continue;
          }
          
          // Validate and sanitize history data
          historyData.set(key, {
            minVoltage: isNaN(value.minVoltage) ? 12.0 : value.minVoltage,
            maxVoltage: isNaN(value.maxVoltage) ? 12.0 : value.maxVoltage,
            dischargedEnergy: isNaN(value.dischargedEnergy) ? 0 : value.dischargedEnergy,
            chargedEnergy: isNaN(value.chargedEnergy) ? 0 : value.chargedEnergy,
            totalAhDrawn: isNaN(value.totalAhDrawn) ? 0 : value.totalAhDrawn
          });
        }
      }
      
      if (parsed.energyAccumulators) {
        for (const [key, value] of Object.entries(parsed.energyAccumulators)) {
          // Skip undefined, null, or empty keys
          if (!key || key === 'undefined' || key === 'null') {
            this.logger.debug(`Skipping invalid accumulator key during load: ${key}`);
            continue;
          }
          
          // Only load if we have corresponding history data
          if (!historyData.has(key)) {
            this.logger.debug(`Skipping accumulator without history data during load: ${key}`);
            continue;
          }
          
          // Validate and sanitize energy accumulator data
          energyAccumulators.set(key, {
            lastCurrent: isNaN(value.lastCurrent) ? 0 : value.lastCurrent,
            lastVoltage: isNaN(value.lastVoltage) ? 12.0 : value.lastVoltage,
            lastTimestamp: isNaN(value.lastTimestamp) ? Date.now() : value.lastTimestamp
          });
        }
      }
      
      if (parsed.lastUpdateTime) {
        for (const [key, value] of Object.entries(parsed.lastUpdateTime)) {
          // Skip undefined, null, or empty keys
          if (!key || key === 'undefined' || key === 'null') {
            this.logger.debug(`Skipping invalid timestamp key during load: ${key}`);
            continue;
          }
          
          // Only load if we have corresponding history data
          if (!historyData.has(key)) {
            this.logger.debug(`Skipping timestamp without history data during load: ${key}`);
            continue;
          }
          
          // Validate and sanitize timestamp data
          lastUpdateTime.set(key, isNaN(value) ? Date.now() : value);
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
      // Convert Maps to plain objects for JSON serialization and validate values
      const sanitizedHistoryData = {};
      const sanitizedEnergyAccumulators = {};
      const sanitizedLastUpdateTime = {};
      
      // Sanitize history data - filter out invalid keys and default values
      for (const [key, value] of historyData.entries()) {
        // Skip undefined, null, or empty keys
        if (!key || key === 'undefined' || key === 'null') {
          this.logger.debug(`Skipping invalid history key: ${key}`);
          continue;
        }
        
        // Skip entries with all default values (no real data collected)
        const hasRealData = (value.dischargedEnergy > 0) || 
                           (value.chargedEnergy > 0) || 
                           (value.totalAhDrawn > 0.001) || // Allow very small values that might be real
                           (value.minVoltage !== 12.0 && value.minVoltage > 5.0 && value.minVoltage < 50.0) ||
                           (value.maxVoltage !== 12.0 && value.maxVoltage > 5.0 && value.maxVoltage < 50.0);
        
        if (!hasRealData) {
          this.logger.debug(`Skipping device with only default values: ${key} (min: ${value.minVoltage}V, max: ${value.maxVoltage}V, discharge: ${value.dischargedEnergy}kWh, Ah: ${value.totalAhDrawn})`);
          continue;
        }
        
        sanitizedHistoryData[key] = {
          minVoltage: isNaN(value.minVoltage) ? 12.0 : value.minVoltage,
          maxVoltage: isNaN(value.maxVoltage) ? 12.0 : value.maxVoltage,
          dischargedEnergy: isNaN(value.dischargedEnergy) ? 0 : value.dischargedEnergy,
          chargedEnergy: isNaN(value.chargedEnergy) ? 0 : value.chargedEnergy,
          totalAhDrawn: isNaN(value.totalAhDrawn) ? 0 : value.totalAhDrawn
        };
      }
      
      // Sanitize energy accumulators - filter out invalid keys
      for (const [key, value] of energyAccumulators.entries()) {
        // Skip undefined, null, or empty keys
        if (!key || key === 'undefined' || key === 'null') {
          this.logger.debug(`Skipping invalid accumulator key: ${key}`);
          continue;
        }
        
        // Only save if we have the corresponding history data
        if (!sanitizedHistoryData[key]) {
          this.logger.debug(`Skipping accumulator without history data: ${key}`);
          continue;
        }
        
        sanitizedEnergyAccumulators[key] = {
          lastCurrent: isNaN(value.lastCurrent) ? 0 : value.lastCurrent,
          lastVoltage: isNaN(value.lastVoltage) ? 12.0 : value.lastVoltage,
          lastTimestamp: isNaN(value.lastTimestamp) ? Date.now() : value.lastTimestamp
        };
      }
      
      // Sanitize last update time - filter out invalid keys
      for (const [key, value] of lastUpdateTime.entries()) {
        // Skip undefined, null, or empty keys
        if (!key || key === 'undefined' || key === 'null') {
          this.logger.debug(`Skipping invalid timestamp key: ${key}`);
          continue;
        }
        
        // Only save if we have the corresponding history data
        if (!sanitizedHistoryData[key]) {
          this.logger.debug(`Skipping timestamp without history data: ${key}`);
          continue;
        }
        
        sanitizedLastUpdateTime[key] = isNaN(value) ? Date.now() : value;
      }
      
      const dataToSave = {
        historyData: sanitizedHistoryData,
        energyAccumulators: sanitizedEnergyAccumulators,
        lastUpdateTime: sanitizedLastUpdateTime,
        lastSaved: new Date().toISOString()
      };
      
      // Ensure directory exists before writing
      const dir = path.dirname(this.dataPath);
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (mkdirError) {
        // Directory might already exist, that's OK
        if (mkdirError.code !== 'EEXIST') {
          throw mkdirError;
        }
      }
      
      // Write to temp file first, then rename (atomic operation)
      const tempPath = this.dataPath + '.tmp';
      await fs.writeFile(tempPath, JSON.stringify(dataToSave, null, 2));
      await fs.rename(tempPath, this.dataPath);
      
      this.logger.debug(`Saved history data for ${Object.keys(sanitizedHistoryData).length} devices with real data`);
      
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
