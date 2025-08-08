import { VEDBusService } from './vedbus.js';
import { DEVICE_CONFIGS } from './deviceConfigs.js';
import { HistoryPersistence } from './historyPersistence.js';
import EventEmitter from 'events';

/**
 * Unified VenusClient that uses the central VEDBus service for all device types
 * This replaces the individual device clients with a single, configurable implementation
 */
export class VenusClient extends EventEmitter {
  constructor(settings, deviceType, logger = null) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.logger = logger || { debug: () => {}, error: () => {} }; // Fallback logger
    this.signalKApp = null; // Store reference to Signal K app for getting current values
    
    // Map plural device types to singular for internal configuration lookup
    const deviceTypeMap = {
      'batteries': 'battery',
      'tanks': 'tank', 
      'switches': 'switch',
      'environment': 'environment'
    };
    
    const configDeviceType = deviceTypeMap[deviceType] || deviceType;
    this.deviceConfig = DEVICE_CONFIGS[configDeviceType];
    
    if (!this.deviceConfig) {
      throw new Error(`Unsupported device type: ${deviceType}. Supported types: ${Object.keys(deviceTypeMap).join(', ')}`);
    }
    
    // Store the internal config device type for logic operations
    this._internalDeviceType = configDeviceType;
    
    this.bus = null;
    this.deviceIndex = 0; // For unique device indexing
    this.deviceCounts = {}; // Track how many devices of each type we have
    this.deviceInstances = new Map(); // Track device instances by Signal K path
    this.deviceServices = new Map(); // Track individual device services
    this.exportedInterfaces = new Set(); // Track which D-Bus interfaces have been exported
    
    // Throttle mechanism for reducing noisy "Processing data update" logs
    this._lastDataUpdateLog = new Map(); // Map of deviceInstance.basePath -> last log timestamp
    this._dataUpdateLogInterval = 10000; // Log every 10 seconds per device
    
    // History tracking for VRM consumption calculations
    this.historyData = new Map(); // Map of devicePath -> history tracking object
    this.lastUpdateTime = new Map(); // Map of devicePath -> last update timestamp
    this.energyAccumulators = new Map(); // Map of devicePath -> energy accumulation data
    
    // History persistence
    this.historyPersistence = new HistoryPersistence('./signalk-battery-history.json', this.logger);
    this._historyLoaded = false;
  }

  // Set Signal K app reference for getting current values
  setSignalKApp(app) {
    this.signalKApp = app;
  }

  // Load history data from persistent storage
  async loadHistoryData() {
    if (this._historyLoaded) {
      return; // Already loaded
    }
    
    try {
      const loaded = await this.historyPersistence.loadHistoryData();
      this.historyData = loaded.historyData;
      this.lastUpdateTime = loaded.lastUpdateTime;
      this.energyAccumulators = loaded.energyAccumulators;
      
      this._historyLoaded = true;
      this.logger.debug(`Loaded persistent history data for ${this.historyData.size} devices`);
      
      // Clean up any invalid entries that may have been loaded
      this.cleanupHistoryData();
      
      // Start periodic saving
      this.historyPersistence.startPeriodicSaving(
        this.historyData, 
        this.energyAccumulators, 
        this.lastUpdateTime
      );
      
      // Start periodic history updates to ensure consumption tracking even without Signal K updates
      this.startPeriodicHistoryUpdates();
      
    } catch (error) {
      this.logger.error(`Failed to load history data: ${error.message}`);
      this._historyLoaded = true; // Mark as loaded even if failed to prevent retries
    }
  }

  // Save history data to persistent storage
  async saveHistoryData() {
    if (!this._historyLoaded) {
      return; // Not loaded yet, nothing to save
    }
    
    // Clean up invalid entries before saving
    this.cleanupHistoryData();
    
    try {
      await this.historyPersistence.saveHistoryData(
        this.historyData,
        this.energyAccumulators,
        this.lastUpdateTime
      );
    } catch (error) {
      this.logger.error(`Failed to save history data: ${error.message}`);
    }
  }

  // Clean up invalid history data entries
  cleanupHistoryData() {
    const keysToRemove = [];
    
    // Find invalid keys
    for (const [key, value] of this.historyData.entries()) {
      // Remove undefined, null, or empty keys
      if (!key || key === 'undefined' || key === 'null') {
        keysToRemove.push(key);
        continue;
      }
      
      // Remove entries with all default values (no real data collected)
      const hasRealData = (value.dischargedEnergy > 0) || 
                         (value.chargedEnergy > 0) || 
                         (value.totalAhDrawn > 0.001) ||
                         (value.minimumVoltage !== null && value.minimumVoltage > 5.0 && value.minimumVoltage < 50.0) ||
                         (value.maximumVoltage !== null && value.maximumVoltage > 5.0 && value.maximumVoltage < 50.0);
      
      if (!hasRealData) {
        keysToRemove.push(key);
      }
    }
    
    // Remove invalid entries from all maps
    for (const key of keysToRemove) {
      this.logger.debug(`Removing invalid history entry: ${key}`);
      this.historyData.delete(key);
      this.energyAccumulators.delete(key);
      this.lastUpdateTime.delete(key);
    }
    
    if (keysToRemove.length > 0) {
      this.logger.debug(`Cleaned up ${keysToRemove.length} invalid history entries`);
    }
  }

  // Initialize history tracking for a battery device
  async initializeHistoryTracking(devicePath, initialVoltage) {
    // Validate devicePath to prevent undefined keys
    if (!devicePath || devicePath === 'undefined' || devicePath === 'null') {
      this.logger.error(`Invalid devicePath for history initialization: ${devicePath}`);
      return;
    }
    
    // Don't reinitialize if already exists (prevents conflicts)
    if (this.historyData.has(devicePath)) {
      return;
    }
    
    // Load history data if not already loaded
    await this.loadHistoryData();
    
    const now = Date.now();
    
    // Only use initial voltage if it's a real measured value
    // Don't initialize min/max with fallback values
    const hasRealInitialVoltage = (typeof initialVoltage === 'number' && !isNaN(initialVoltage) && initialVoltage !== 12.0);
    const validInitialVoltage = hasRealInitialVoltage ? initialVoltage : 12.0; // 12.0 only for accumulator
    
    // Check if we have existing history data for this device (may have been loaded from disk)
    if (!this.historyData.has(devicePath)) {
      this.historyData.set(devicePath, {
        minimumVoltage: null, // Will be set to first real voltage value
        maximumVoltage: null, // Will be set to first real voltage value
        dischargedEnergy: 0, // kWh
        chargedEnergy: 0,    // kWh
        totalAhDrawn: 0      // Ah
      });
      
      this.lastUpdateTime.set(devicePath, now);
      
      this.energyAccumulators.set(devicePath, {
        lastCurrent: 0,
        lastVoltage: validInitialVoltage,
        lastTimestamp: now
      });
      
      this.logger.debug(`Initialized new history tracking for ${devicePath}`);
    } else {
      // Update existing data with current voltage if needed and validate existing values
      const existing = this.historyData.get(devicePath);
      
      // Validate and fix any NaN values in existing data
      if (isNaN(existing.minimumVoltage)) existing.minimumVoltage = null;
      if (isNaN(existing.maximumVoltage)) existing.maximumVoltage = null;
      if (isNaN(existing.dischargedEnergy)) existing.dischargedEnergy = 0;
      if (isNaN(existing.chargedEnergy)) existing.chargedEnergy = 0;
      if (isNaN(existing.totalAhDrawn)) existing.totalAhDrawn = 0;
      
      // Also validate loaded accumulator data
      const existingAccumulator = this.energyAccumulators.get(devicePath);
      if (existingAccumulator) {
        if (isNaN(existingAccumulator.lastCurrent)) existingAccumulator.lastCurrent = 0;
        if (isNaN(existingAccumulator.lastVoltage) || existingAccumulator.lastVoltage === 0) {
          // If we have a real voltage now, use it, otherwise use fallback
          if (initialVoltage && initialVoltage > 5.0) {
            existingAccumulator.lastVoltage = initialVoltage;
          } else {
            existingAccumulator.lastVoltage = 12.0; // Fallback for accumulator calculations
          }
        }
        if (isNaN(existingAccumulator.lastTimestamp)) existingAccumulator.lastTimestamp = Date.now();
      }
      
      // Update min/max voltage with valid initial voltage ONLY if it's a real voltage value
      // Don't initialize with fallback values (12.0) - only use actual measured voltages
      if (hasRealInitialVoltage) {
        if (initialVoltage < existing.minimumVoltage || existing.minimumVoltage === null) {
          existing.minimumVoltage = initialVoltage;
        }
        if (initialVoltage > existing.maximumVoltage || existing.maximumVoltage === null) {
          existing.maximumVoltage = initialVoltage;
        }
      }
      
      this.logger.debug(`Restored existing history tracking for ${devicePath}`);
    }
  }

  // Update history data based on current battery values
  async updateHistoryData(devicePath, voltage, current, power) {
    // Validate devicePath to prevent undefined keys
    if (!devicePath || devicePath === 'undefined' || devicePath === 'null') {
      this.logger.error(`Invalid devicePath for history update: ${devicePath}`);
      return null;
    }
    
    if (!this.historyData.has(devicePath)) {
      // If history data hasn't been loaded yet, ensure it's loaded first
      // This prevents creating empty data that overwrites loaded values
      if (!this._historyLoaded) {
        this.logger.debug(`History not loaded yet for ${devicePath}, loading first...`);
        await this.loadHistoryData();
      }
      
      // After loading, check again if we now have the device data
      if (!this.historyData.has(devicePath)) {
        // Device not in loaded data, so create new entry
        const validInitialVoltage = (typeof voltage === 'number' && !isNaN(voltage)) ? voltage : null;
        
        if (validInitialVoltage !== null) {
          // Initialize properly through the normal initialization path
          await this.initializeHistoryTracking(devicePath, validInitialVoltage);
        } else {
          // Create minimal structure for devices without valid voltage
          this.historyData.set(devicePath, {
            minimumVoltage: null,
            maximumVoltage: null,
            dischargedEnergy: 0,
            chargedEnergy: 0,
            totalAhDrawn: 0
          });
          
          this.lastUpdateTime.set(devicePath, Date.now());
          
          this.energyAccumulators.set(devicePath, {
            lastCurrent: 0,
            lastVoltage: 12.0,
            lastTimestamp: Date.now()
          });
          
          this.logger.debug(`Created minimal history structure for ${devicePath} (no valid voltage)`);
        }
      }
    }
    
    const history = this.historyData.get(devicePath);
    const accumulator = this.energyAccumulators.get(devicePath);
    
    // Safety check - should not happen anymore but just in case
    if (!history) {
      this.logger.error(`History data not available for ${devicePath} - this should not happen`);
      return null;
    }
    
    const now = Date.now();
    const lastTime = this.lastUpdateTime.get(devicePath) || now;
    
    // Validate input values to prevent NaN propagation
    const validVoltage = (typeof voltage === 'number' && !isNaN(voltage)) ? voltage : null;
    const validCurrent = (typeof current === 'number' && !isNaN(current)) ? current : null;
    const validPower = (typeof power === 'number' && !isNaN(power)) ? power : null;
    
    // Update min/max voltage only with valid values and prevent 0 values
    if (validVoltage !== null && validVoltage > 5.0) { // Only track voltage above 5V
      if (history.minimumVoltage === null || validVoltage < history.minimumVoltage) {
        history.minimumVoltage = validVoltage;
      }
      if (history.maximumVoltage === null || validVoltage > history.maximumVoltage) {
        history.maximumVoltage = validVoltage;
      }
    }
    
    // Calculate energy accumulation if we have valid previous data
    if (accumulator && validCurrent !== null && validVoltage !== null) {
      const deltaTimeHours = (now - lastTime) / (1000 * 3600); // Convert to hours
      
      if (deltaTimeHours > 0 && deltaTimeHours < 1) { // Sanity check: less than 1 hour
        // Get solar and alternator currents for the new calculation method
        const solarCurrent = this._getSolarCurrent() || 0;
        const alternatorCurrent = this._getAlternatorCurrent() || 0;
        
        // Your corrected specification: 
        // Cumulative Ah drawn = S + L - A (Solar + Alternator - Battery Current)
        // Discharged energy: If A < 0 then use A (battery current itself)
        // Charged energy: If A > 0 then use A (battery current itself)
        
        this.logger.debug(`Energy calculation for ${devicePath}: Solar=${solarCurrent.toFixed(1)}A, Alt=${alternatorCurrent.toFixed(1)}A, Battery=${validCurrent.toFixed(1)}A`);
        
        // Calculate discharge consumption using S + L - A formula
        const dischargeConsumption = solarCurrent + alternatorCurrent - validCurrent;
        
        // Clamp discharge consumption to 0 if negative (prevents false values)
        const clampedDischargeConsumption = Math.max(0, dischargeConsumption);
        
        this.logger.debug(`Discharge consumption calculation: S(${solarCurrent.toFixed(1)}) + L(${alternatorCurrent.toFixed(1)}) - A(${validCurrent.toFixed(1)}) = ${dischargeConsumption.toFixed(1)}A, clamped to ${clampedDischargeConsumption.toFixed(1)}A`);
        
        // Accumulate total Ah drawn using the clamped consumption
        if (clampedDischargeConsumption > 0) {
          const consumptionDelta = clampedDischargeConsumption * deltaTimeHours;
          
          if (!isNaN(history.totalAhDrawn)) {
            history.totalAhDrawn += consumptionDelta;
          } else {
            history.totalAhDrawn = consumptionDelta;
          }
          
          this.logger.debug(`Total Ah drawn updated: +${consumptionDelta.toFixed(3)}Ah, total: ${history.totalAhDrawn.toFixed(3)}Ah`);
        }
        
        if (validCurrent < 0) {
          // Battery is discharging - use battery current (A) for discharged energy
          const dischargeEnergyDelta = (validVoltage * Math.abs(validCurrent) * deltaTimeHours) / 1000; // kWh
          
          if (!isNaN(history.dischargedEnergy)) {
            history.dischargedEnergy += dischargeEnergyDelta;
          } else {
            history.dischargedEnergy = dischargeEnergyDelta;
          }
          
          this.logger.debug(`Battery discharging: ${validCurrent.toFixed(1)}A → +${dischargeEnergyDelta.toFixed(4)}kWh discharged`);
          
        } else if (validCurrent > 0) {
          // Battery is charging - use battery current (A) for charged energy  
          const chargeEnergyDelta = (validVoltage * validCurrent * deltaTimeHours) / 1000; // kWh
          
          if (!isNaN(history.chargedEnergy)) {
            history.chargedEnergy += chargeEnergyDelta;
          } else {
            history.chargedEnergy = chargeEnergyDelta;
          }
          
          this.logger.debug(`Battery charging: ${validCurrent.toFixed(1)}A → +${chargeEnergyDelta.toFixed(4)}kWh charged`);
        }
      }
    }
    
    // Update accumulator with valid values - only update if we have valid data
    // This should happen regardless of whether energy calculation occurred
    if (accumulator) {
      if (validCurrent !== null) {
        accumulator.lastCurrent = validCurrent;
      }
      if (validVoltage !== null) {
        accumulator.lastVoltage = validVoltage;
      }
      accumulator.lastTimestamp = now;
    }
    
    // Ensure all history values are valid numbers
    if (isNaN(history.dischargedEnergy)) history.dischargedEnergy = 0;
    if (isNaN(history.chargedEnergy)) history.chargedEnergy = 0;
    if (isNaN(history.totalAhDrawn)) history.totalAhDrawn = 0;
    // Note: minimumVoltage and maximumVoltage can be null until first real voltage is received
    
    this.lastUpdateTime.set(devicePath, now);
    return history;
  }

  // Helper methods to get solar and alternator current for energy calculations
  _getSolarCurrent() {
    if (!this.signalKApp) return 0;
    
    try {
      // Check common solar current paths
      const solarPaths = [
        'electrical.solar.current',
        'electrical.chargers.solar.current',
        'electrical.solar.0.current',
        'electrical.solar.1.current'
      ];
      
      let totalSolarCurrent = 0;
      for (const path of solarPaths) {
        const value = this._getCurrentSignalKValue(path);
        if (value !== null && typeof value === 'number' && !isNaN(value) && value >= 0) {
          totalSolarCurrent += value;
        }
      }
      
      return totalSolarCurrent;
    } catch (err) {
      this.logger.debug(`Error getting solar current: ${err.message}`);
      return 0;
    }
  }
  
  _getAlternatorCurrent() {
    if (!this.signalKApp) return 0;
    
    try {
      // Check common alternator current paths
      const alternatorPaths = [
        'electrical.alternators.current',
        'electrical.alternators.0.current',
        'electrical.alternators.1.current',
        'propulsion.main.alternator.current',
        'propulsion.port.alternator.current',
        'propulsion.starboard.alternator.current'
      ];
      
      let totalAlternatorCurrent = 0;
      for (const path of alternatorPaths) {
        const value = this._getCurrentSignalKValue(path);
        if (value !== null && typeof value === 'number' && !isNaN(value) && value >= 0) {
          totalAlternatorCurrent += value;
        }
      }
      
      return totalAlternatorCurrent;
    } catch (err) {
      this.logger.debug(`Error getting alternator current: ${err.message}`);
      return 0;
    }
  }

  // Calculate total system power consumption including all energy sources
  _calculateSystemPower(batteryDevicePath, batteryVoltage, batteryCurrent, batteryPower) {
    // Start with battery power as baseline
    const baseBatteryPower = batteryPower !== null ? batteryPower : (batteryVoltage * batteryCurrent);
    
    let totalSystemPower = baseBatteryPower;
    let solarPower = 0;
    let alternatorPower = 0;
    let shorePower = 0;
    let hasAdditionalSources = false;
    
    if (!this.signalKApp) {
      return {
        totalSystemPower: baseBatteryPower,
        solarPower: 0,
        alternatorPower: 0,
        shorePower: 0,
        hasAdditionalSources: false
      };
    }
    
    try {
      // Get solar power from Signal K
      // Common solar paths: electrical.solar.*, electrical.chargers.*, etc.
      const solarPaths = [
        'electrical.solar.current',
        'electrical.solar.power',
        'electrical.chargers.solar.current',
        'electrical.chargers.solar.power'
      ];
      
      for (const path of solarPaths) {
        const value = this._getCurrentSignalKValue(path);
        if (value !== null && typeof value === 'number' && !isNaN(value)) {
          if (path.includes('power')) {
            solarPower += Math.abs(value);
          } else if (path.includes('current')) {
            solarPower += Math.abs(value) * batteryVoltage; // I * V = P
          }
          hasAdditionalSources = true;
        }
      }
      
      // Get alternator power from Signal K
      // Common alternator paths: electrical.alternators.*, propulsion.*.alternator.*
      const alternatorPaths = [
        'electrical.alternators.current',
        'electrical.alternators.power',
        'propulsion.main.alternator.current',
        'propulsion.main.alternator.power',
        'propulsion.port.alternator.current',
        'propulsion.port.alternator.power',
        'propulsion.starboard.alternator.current', 
        'propulsion.starboard.alternator.power'
      ];
      
      for (const path of alternatorPaths) {
        const value = this._getCurrentSignalKValue(path);
        if (value !== null && typeof value === 'number' && !isNaN(value)) {
          if (path.includes('power')) {
            alternatorPower += Math.abs(value);
          } else if (path.includes('current')) {
            alternatorPower += Math.abs(value) * batteryVoltage; // I * V = P
          }
          hasAdditionalSources = true;
        }
      }
      
      // Get shore power from Signal K
      // Common shore power paths: electrical.shore.*, electrical.chargers.shore.*
      const shorePaths = [
        'electrical.shore.current',
        'electrical.shore.power',
        'electrical.chargers.shore.current',
        'electrical.chargers.shore.power',
        'electrical.chargers.mains.current',
        'electrical.chargers.mains.power'
      ];
      
      for (const path of shorePaths) {
        const value = this._getCurrentSignalKValue(path);
        if (value !== null && typeof value === 'number' && !isNaN(value)) {
          if (path.includes('power')) {
            shorePower += Math.abs(value);
          } else if (path.includes('current')) {
            shorePower += Math.abs(value) * batteryVoltage; // I * V = P
          }
          hasAdditionalSources = true;
        }
      }
      
      // Calculate total system consumption
      // If battery is discharging (negative current), add other sources
      // If battery is charging (positive current), account for excess generation
      if (batteryCurrent < 0) {
        // Battery discharging: Total consumption = Battery discharge + Direct consumption from other sources
        totalSystemPower = Math.abs(baseBatteryPower) + solarPower + alternatorPower + shorePower;
      } else if (batteryCurrent > 0) {
        // Battery charging: Some generation goes to battery, some to direct consumption
        // We can't easily determine the split without load monitoring, so we use a heuristic
        const totalGeneration = solarPower + alternatorPower + shorePower;
        const batteryChargePower = Math.abs(baseBatteryPower);
        
        if (totalGeneration > batteryChargePower) {
          // Excess generation goes to direct consumption
          totalSystemPower = totalGeneration - batteryChargePower;
        } else {
          // All generation goes to battery, no additional consumption tracked
          totalSystemPower = 0; // No net consumption when charging from external sources
        }
      }
      
    } catch (error) {
      this.logger.debug(`Error calculating system power: ${error.message}`);
      // Fallback to battery power only
      totalSystemPower = baseBatteryPower;
    }
    
    return {
      totalSystemPower: totalSystemPower,
      solarPower: solarPower,
      alternatorPower: alternatorPower,
      shorePower: shorePower,
      hasAdditionalSources: hasAdditionalSources
    };
  }

  // Helper function to get current Signal K value
  _getCurrentSignalKValue(path) {
    if (this.signalKApp && this.signalKApp.getSelfPath) {
      try {
        return this.signalKApp.getSelfPath(path);
      } catch (err) {
        this.logger.debug(`Could not get Signal K value for ${path}: ${err.message}`);
        return null;
      }
    }
    return null;
  }

  // Helper function to wrap values in D-Bus variant format
  wrapValue(type, value) {
    return [type, value];
  }

  // Helper function to get D-Bus type for JavaScript values
  getType(value) {
    if (typeof value === 'string') return 's';
    if (typeof value === 'number' && Number.isInteger(value)) return 'i';
    if (typeof value === 'number') return 'd';
    if (typeof value === 'boolean') return 'b';
    return 'v'; // variant for unknown types
  }

  async _getOrCreateDeviceInstance(path) {
    // Extract the base device path using device-specific logic
    const basePath = this._extractBasePath(path);
    
    // Validate basePath
    if (!basePath) {
      this.logger.error(`Failed to extract valid basePath from: ${path}`);
      return null;
    }
    
    if (!this.deviceInstances.has(basePath)) {
      // Mark that we're creating this device to prevent duplicate creation
      this.deviceInstances.set(basePath, 'creating');

      try {
        // Create a deterministic index based on the path hash to ensure consistency
        const index = this._generateStableIndex(basePath);
        const deviceInstance = {
          index: index,
          name: this._getDeviceName(path),
          basePath: basePath
        };
        
        // Create device service for this device with its own D-Bus connection
        const deviceService = new VEDBusService(
          `SignalK${deviceInstance.index}`,
          deviceInstance,
          this.settings,
          this.deviceConfig,
          this.logger,
          (path) => this._getCurrentSignalKValue(path) // Signal K value getter
        );

        await deviceService.init(); // Initialize the device service
        
        // Store the basePath on the deviceService for easy access
        deviceService.basePath = basePath;
        
        // Debug: Verify basePath is correctly set
        if (!deviceService.basePath) {
          this.logger.error(`Failed to set basePath on deviceService: ${basePath}`);
        } else {
          this.logger.debug(`Successfully set basePath on deviceService: ${deviceService.basePath}`);
        }

        // we should really have a vedbus-tank, vedbus-battery, etc to get rid of this.
        switch (this._internalDeviceType) {
          case 'tank':
            await deviceService.updateProperty('/FluidType', this._getFluidType(path), 'i', `Fluid Type`);
            break;

          case 'battery':
            // Initialize battery monitor properties - Venus OS requires all these paths to be present
            await deviceService.updateProperty('/System/HasBatteryMonitor', 1, 'i', 'Has battery monitor');
            // NOTE: Battery capacity will only be set when real Signal K data arrives
            // No more fake default capacity to prevent false data pollution
            
            // IMPORTANT: Don't initialize ConsumedAmphours with fake data
            // This will be calculated from real SOC when Signal K data arrives
            
            // CRITICAL: Don't initialize battery data properties with fake values!
            // Only initialize if we have real Signal K values available
            // These properties will be set when actual Signal K data arrives
            
            // Check if we have real Signal K values and use those for initialization
            const basePath = deviceInstance.basePath;
            if (basePath && this.signalKApp) {
              try {
                // Try to get real current values from Signal K
                const currentSoc = this._getCurrentSignalKValue(`${basePath}.capacity.stateOfCharge`);
                const currentVoltage = this._getCurrentSignalKValue(`${basePath}.voltage`);
                const currentCurrent = this._getCurrentSignalKValue(`${basePath}.current`);
                const currentPower = this._getCurrentSignalKValue(`${basePath}.power`);
                const currentTemp = this._getCurrentSignalKValue(`${basePath}.temperature`);
                
                // Only initialize properties if we have real values
                if (currentSoc !== null && currentSoc !== undefined && typeof currentSoc === 'number') {
                  const socPercent = currentSoc > 1 ? currentSoc : currentSoc * 100;
                  await deviceService.updateProperty('/Soc', socPercent, 'd', 'State of charge');
                  this.logger.debug(`Initialized SOC with real Signal K value: ${socPercent}%`);
                }
                
                if (currentVoltage !== null && currentVoltage !== undefined && typeof currentVoltage === 'number') {
                  await deviceService.updateProperty('/Dc/0/Voltage', currentVoltage, 'd', 'Battery voltage');
                  this.logger.debug(`Initialized voltage with real Signal K value: ${currentVoltage}V`);
                }
                
                if (currentCurrent !== null && currentCurrent !== undefined && typeof currentCurrent === 'number') {
                  await deviceService.updateProperty('/Dc/0/Current', currentCurrent, 'd', 'Battery current');
                  this.logger.debug(`Initialized current with real Signal K value: ${currentCurrent}A`);
                }
                
                if (currentPower !== null && currentPower !== undefined && typeof currentPower === 'number') {
                  await deviceService.updateProperty('/Dc/0/Power', currentPower, 'd', 'Battery power');
                  this.logger.debug(`Initialized power with real Signal K value: ${currentPower}W`);
                }
                
                if (currentTemp !== null && currentTemp !== undefined && typeof currentTemp === 'number') {
                  // Convert temperature if needed (from Kelvin)
                  const tempCelsius = currentTemp > 100 ? currentTemp - 273.15 : currentTemp;
                  await deviceService.updateProperty('/Dc/0/Temperature', tempCelsius, 'd', 'Battery temperature');
                  this.logger.debug(`Initialized temperature with real Signal K value: ${tempCelsius}°C`);
                }
                
                // Calculate initial consumed Ah and time to go if we have SOC and capacity
                if (currentSoc !== null && typeof currentSoc === 'number') {
                  const socPercent = currentSoc > 1 ? currentSoc : currentSoc * 100;
                  
                  // Try to get real capacity data from Signal K, fall back to settings
                  const capacityPath = `${basePath}.capacity.nominal`;
                  const signalKCapacity = this.signalKApp.getSelfPath(capacityPath);
                  
                  // Use Signal K capacity if available, otherwise use settings capacity
                  let workingCapacity = null;
                  if (signalKCapacity && typeof signalKCapacity === 'number' && signalKCapacity > 0) {
                    // Signal K capacity is in Joules, convert to Ah: Joules / (Voltage * 3600)
                    if (currentVoltage && typeof currentVoltage === 'number' && currentVoltage > 0) {
                      workingCapacity = signalKCapacity / (currentVoltage * 3600);
                    } else {
                      // Fallback: use typical 12V if voltage not available
                      workingCapacity = signalKCapacity / (12 * 3600);
                    }
                  } else if (this.settings.batteryCapacity) {
                    workingCapacity = this.settings.batteryCapacity;
                  }
                  
                  if (workingCapacity && typeof workingCapacity === 'number' && workingCapacity > 0) {
                    const consumedAh = workingCapacity * (100 - socPercent) / 100;
                    await deviceService.updateProperty('/ConsumedAmphours', consumedAh, 'd', 'Consumed Ah');
                    await deviceService.updateProperty('/Capacity', workingCapacity, 'd', 'Battery capacity');
                    
                    // Calculate realistic time to go based on SOC and capacity
                    if (currentCurrent !== null && typeof currentCurrent === 'number' && currentCurrent !== 0) {
                      let timeToGoSeconds;
                      
                      if (currentCurrent < 0) {
                        // Battery is discharging - calculate time until empty
                        const remainingCapacity = workingCapacity * (socPercent / 100);
                        const timeToGoHours = remainingCapacity / Math.abs(currentCurrent);
                        timeToGoSeconds = Math.round(timeToGoHours * 3600);
                      } else {
                        // Battery is charging - calculate time to 100% SoC
                        const remainingCapacityToFull = workingCapacity * ((100 - socPercent) / 100);
                        const chargeTimeHours = remainingCapacityToFull / currentCurrent;
                        timeToGoSeconds = Math.round(chargeTimeHours * 3600);
                      }
                      
                      await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', 'Time to go');
                    }
                  }
                }
                
                // Initialize history tracking for this battery
                await this.initializeHistoryTracking(basePath, currentVoltage || 12.0);
                
              } catch (err) {
                this.logger.debug(`Could not get initial Signal K values for battery initialization: ${err.message}`);
                // Don't set any default values - let updateProperty handle first real values
              }
            }
            
            // NOTE: We no longer initialize /Soc, /Dc/0/Voltage, /Dc/0/Current, /Dc/0/Power with fake defaults
            // These will only be set when real Signal K data arrives via handleSignalKUpdate
            
            // Initialize relay state (normally closed for battery monitors)
            await deviceService.updateProperty('/Relay/0/State', 0, 'i', 'Battery relay state');
            
            // Additional battery monitor specific paths that Venus OS might need
            await deviceService.updateProperty('/System/BatteryService', 1, 'i', 'Battery service');
            
            // Critical properties for BMV recognition by Venus OS system service
            await deviceService.updateProperty('/System/NrOfBatteries', 1, 'i', 'Number of batteries');
            // NOTE: Min/Max cell voltage removed - they'll be set with real data only
            
            // Initialize additional paths that might be needed for proper battery monitor display
            // State: 0 = Offline, 1 = Online, 2 = Error, 3 = Unavailable - use 1 for Online
            await deviceService.updateProperty('/State', 1, 'i', 'Battery state');
            await deviceService.updateProperty('/ErrorCode', 0, 'i', 'Error code');
            await deviceService.updateProperty('/Alarms/LowVoltage', 0, 'i', 'Low voltage alarm');
            await deviceService.updateProperty('/Alarms/HighVoltage', 0, 'i', 'High voltage alarm');
            await deviceService.updateProperty('/Alarms/LowSoc', 0, 'i', 'Low SOC alarm');
            await deviceService.updateProperty('/Alarms/HighCurrent', 0, 'i', 'High current alarm');
            await deviceService.updateProperty('/Alarms/HighTemperature', 0, 'i', 'High temperature alarm');
            await deviceService.updateProperty('/Alarms/LowTemperature', 0, 'i', 'Low temperature alarm');
            
            // Add Connected property which Venus OS requires for BMV recognition
            await deviceService.updateProperty('/Connected', 1, 'i', 'Connected');
            
            // Add DeviceType property - 512 is the code for BMV
            await deviceService.updateProperty('/DeviceType', 512, 'i', 'Device type');
            
            // Add critical system integration properties that Venus OS system service needs
            // These are essential for proper VRM integration and BMV recognition
            await deviceService.updateProperty('/Info/BatteryLowVoltage', 0, 'i', 'Battery low voltage info');
            // NOTE: Removed default MaxChargeCurrent, MaxDischargeCurrent, MaxChargeVoltage - only set with real data
            
            // NOTE: History properties no longer have fake defaults - they'll be set with real data only
            // NOTE: Min/Max voltage tracking removed - will be implemented with real data only  
            // NOTE: Mid voltage properties removed - they'll be set with real data only
            
            // Add balancer information for system service
            await deviceService.updateProperty('/Balancer', 0, 'i', 'Balancer active');
            await deviceService.updateProperty('/Io/AllowToCharge', 1, 'i', 'Allow to charge');
            await deviceService.updateProperty('/Io/AllowToDischarge', 1, 'i', 'Allow to discharge');
            await deviceService.updateProperty('/Io/ExternalRelay', 0, 'i', 'External relay');
            
            break;

          case 'switch':
          case 'environment':
          default:
            break;
        }
        this.deviceServices.set(basePath, deviceService);
        this.deviceInstances.set(basePath, deviceInstance);

        this.logger.debug(`Successfully created device instance for ${basePath} as ${this._internalDeviceType} with VRM instance ${deviceInstance.index}`);
        return deviceInstance;
      } catch (error) {
        this.logger.error(`❌ Error creating device instance for ${basePath} (from path: ${path}):`, error);
        this.logger.error(`❌ Error stack:`, error.stack);
        // Remove the entry to allow retry on next call
        this.deviceInstances.delete(basePath);
        return null;
      }
    } else {
      const existing = this.deviceInstances.get(basePath);
      if (existing === 'creating') {
        // Device is currently being created, wait a bit and try again
        
        // Wait for creation to complete with timeout
        const maxWaitTime = 5000; // 5 seconds max wait
        const pollInterval = 200; // Check every 200ms
        let waitTime = 0;
        
        while (waitTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          waitTime += pollInterval;
          
          const updated = this.deviceInstances.get(basePath);
          if (updated !== 'creating') {
            // Creation completed (either success or failure)
            return updated || null;
          }
        }
        
        // Timeout waiting for creation
        this.logger.warn(`⚠️ Timeout waiting for device creation: ${basePath}`);
        return null;
      }
      
      return existing;
    }
  }

  _extractBasePath(path) {
    if (!path || typeof path !== 'string') {
      this.logger.error(`Invalid path provided to _extractBasePath: ${path}`);
      return null;
    }
    
    let basePath;
    switch (this._internalDeviceType) {
      case 'tank':
        // Handle tank paths like 'tanks.freshWater.0.capacity' -> 'tanks.freshWater.0'
        // and also 'tanks.freshWater.0.currentLevel' -> 'tanks.freshWater.0'
        basePath = path.replace(/\.(currentLevel|capacity|name|currentVolume|voltage)$/, '');
        break;
      case 'battery':
        basePath = path.replace(/\.(voltage|current|stateOfCharge|consumed|timeRemaining|relay|temperature|name|capacity\..*|power)$/, '');
        break;
      case 'switch':
        basePath = path.replace(/\.(state|dimmingLevel|position|name)$/, '');
        break;
      case 'environment':
        basePath = path.replace(/\.(temperature|humidity|relativeHumidity)$/, '');
        break;
      default:
        basePath = path;
        break;
    }
    
    // Ensure we never return empty string or invalid values
    if (!basePath || basePath.trim() === '') {
      this.logger.error(`Extracted basePath is empty from path: ${path}`);
      return null;
    }
    
    return basePath;
  }

  _generateStableIndex(basePath) {
    // Generate a stable index based on the base path to ensure the same device
    // always gets the same index, even across restarts
    let hash = 0;
    for (let i = 0; i < basePath.length; i++) {
      const char = basePath.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Ensure we get a positive number within a reasonable range (0-999)
    return Math.abs(hash) % 1000;
  }

  _getDeviceName(path) {
    switch (this._internalDeviceType) {
      case 'tank':
        return this._getTankName(path);
      case 'battery':
        return this._getBatteryName(path);
      case 'switch':
        return this._getSwitchName(path);
      case 'environment':
        return this._getEnvironmentName(path);
      default:
        return 'Unknown Device';
    }
  }

  _getTankName(path) {
    const parts = path.split('.');
    let tankName = 'Unknown Tank';
    if (parts.length >= 3) {
      const tankType = parts[1]; // e.g., 'fuel', 'freshWater', 'wasteWater'
      const tankLocation = parts[2]; // e.g., 'starboard', 'port', 'main', '0'
      
      const fluidTypeConfig = this.deviceConfig.fluidTypes[tankType];
      if (fluidTypeConfig) {
        let baseTypeName = fluidTypeConfig.name;
        
        // Remove spaces and fix capitalization for consistency (Fresh Water -> Freshwater)
        baseTypeName = baseTypeName.replace(/\s+/g, '').toLowerCase();
        baseTypeName = baseTypeName.charAt(0).toUpperCase() + baseTypeName.slice(1);
        
        // Check if we have multiple tanks of this type
        const tanksOfThisType = Array.from(this.deviceInstances.keys())
          .filter(devicePath => devicePath.includes(`tanks.${tankType}.`)).length;
        
        // Use generic ID detection
        const isGenericId = ['0', 'main', 'primary', 'default'].includes(tankLocation.toLowerCase());
        
        // If single tank with generic ID, omit the ID
        if (tanksOfThisType <= 1 && isGenericId) {
          tankName = baseTypeName;
        } else {
          // Multiple tanks or specific ID - include the ID
          // Convert numeric IDs to start from 1 instead of 0
          let displayLocation = tankLocation;
          if (/^\d+$/.test(tankLocation)) {
            displayLocation = (parseInt(tankLocation) + 1).toString();
          }
          tankName = `${baseTypeName} ${displayLocation}`;
        }
      } else {
        // Unknown tank type - check if we have multiple tanks
        const totalTanks = Array.from(this.deviceInstances.keys())
          .filter(devicePath => devicePath.includes('tanks.')).length;
        
        // Use generic ID detection
        const isGenericId = ['0', 'main', 'primary', 'default'].includes(tankLocation.toLowerCase());
        
        // If single tank with generic ID, omit the ID
        if (totalTanks <= 1 && isGenericId) {
          tankName = 'Unknown Tank';
        } else {
          // Multiple tanks or specific ID - include the ID
          // Convert numeric IDs to start from 1 instead of 0
          let displayLocation = tankLocation;
          if (/^\d+$/.test(tankLocation)) {
            displayLocation = (parseInt(tankLocation) + 1).toString();
          }
          tankName = `Unknown Tank ${displayLocation}`;
        }
      }
    }
    return tankName;
  }

  _getFluidType(path) {
    const parts = path.split('.');
    let fluidType = 0;
    if (parts.length >= 3) {
      const tankType = parts[1]; // e.g., 'fuel', 'freshWater', 'wasteWater'

      fluidType = this.deviceConfig.fluidTypes[tankType].value ?? 0;
    }
    return fluidType;
  }

  _getBatteryName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const batteryId = parts[2]; // e.g., '0', '1', 'main', 'house', 'starter'
      
      // Check if we have multiple batteries
      const totalBatteries = Array.from(this.deviceInstances.keys())
        .filter(devicePath => devicePath.includes('electrical.batteries.')).length;
      
      const isGenericId = ['0', 'main', 'primary', 'default'].includes(batteryId.toLowerCase());
      
      if (totalBatteries <= 1 && isGenericId) {
        return 'Battery';
      }
      
      // Convert numeric IDs to start from 1 instead of 0
      let displayId = batteryId;
      if (/^\d+$/.test(batteryId)) {
        displayId = (parseInt(batteryId) + 1).toString();
      } else {
        // For non-numeric IDs, capitalize first letter
        displayId = batteryId.charAt(0).toUpperCase() + batteryId.slice(1);
      }
      
      return `Battery ${displayId}`;
    }
    return 'Battery';
  }

  _getSwitchName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const switchId = parts[2]; // e.g., 'nav', 'anchor', 'cabinLights', '0', '1'
      
      // Check if we have multiple switches
      const totalSwitches = Array.from(this.deviceInstances.keys())
        .filter(devicePath => devicePath.includes('electrical.switches.')).length;
      
      // If it's a functional name (not just a number), use it directly
      if (!/^\d+$/.test(switchId)) {
        // Convert camelCase to Title Case with spaces
        return switchId.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      } else {
        // It's a numeric ID - check if we should omit the number for single devices
        const numericId = parseInt(switchId);
        if (numericId === 0 && totalSwitches <= 1) {
          // Single device with ID 0 - omit the number
          return 'Switch';
        } else {
          // Multiple devices or ID > 0 - convert to start from 1 instead of 0
          const displayId = (numericId + 1).toString();
          return `Switch ${displayId}`;
        }
      }
    }
    return 'Switch';
  }

  _getEnvironmentName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const environmentType = parts[1]; // e.g., 'water', 'air', 'inside', 'outside'
      
      // Remove camel case and capitalize first letter
      let sensor = environmentType.replace(/([A-Z])/g, ' $1').trim();
      sensor = sensor.charAt(0).toUpperCase() + sensor.slice(1).toLowerCase();
      
      // Return just the location name - Venus OS will show the measurement types separately
      return sensor;
    }
    return 'Environment sensor';
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        return;
      }
      
      // Check if this path is relevant for our device type
      if (!this._isRelevantPath(path)) {
        return;
      }

      // Extract base path to check if device already exists
      const basePath = this._extractBasePath(path);
      if (!basePath) {
        this.logger.error(`Failed to extract valid basePath from: ${path}`);
        return;
      }

      // Check if we already have a device service for this path
      const existingDeviceService = this.deviceServices.get(basePath);
      
      if (existingDeviceService) {
        // We have an existing device - update it with any valid data
        this.logger.debug(`Updating existing device ${basePath} with ${path} = ${value}`);
        
        // Check if device service is connected and ready for data updates
        if (!existingDeviceService.isConnected) {
          this.logger.warn(`⚠️ RACE CONDITION: Device service ${basePath} not connected yet - data update ${path} = ${value} will be dropped`);
          return;
        }
        
        // Get the device instance for the device name
        const deviceInstance = this.deviceInstances.get(basePath);
        if (!deviceInstance) {
          this.logger.error(`Device instance not found for ${basePath}`);
          return;
        }
        
        // Handle the update for existing device
        await this._handleDeviceSpecificUpdate(path, value, existingDeviceService, deviceInstance);
        return;
      }

      // No existing device - only create if we have critical data
      if (!this._shouldCreateDeviceForPath(path, value)) {
        // Store the path and value for later, but don't create the device yet
        this.logger.debug(`Deferring device creation for ${path} - waiting for critical data`);
        return;
      }

      // Initialize if not already done - only when we have real data
      const deviceInstance = await this._getOrCreateDeviceInstance(path);
      if (!deviceInstance) {
        this.logger.error(`Failed to create device instance for ${path}`);
        return;
      }

      // Get the device service
      const deviceService = this.deviceServices.get(deviceInstance.basePath);
      if (!deviceService) {
        this.logger.error(`No device service found for ${deviceInstance.basePath}`);
        return;
      }
      
      // Check if device service is connected and ready for data updates
      if (!deviceService.isConnected) {
        this.logger.warn(`⚠️ RACE CONDITION: Device service ${deviceInstance.basePath} not connected yet - data update ${path} = ${value} will be dropped`);
        return;
      }
      
      // Throttled logging for data updates to reduce noise
      const now = Date.now();
      const lastLogTime = this._lastDataUpdateLog.get(deviceInstance.basePath) || 0;
      
      if (now - lastLogTime > this._dataUpdateLogInterval) {
        this._lastDataUpdateLog.set(deviceInstance.basePath, now);
      }
      
      // Handle the update based on device type
      await this._handleDeviceSpecificUpdate(path, value, deviceService, deviceInstance);
      
    } catch (err) {
      // Handle connection errors gracefully
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
        this.logger.debug(`Connection lost while updating ${path} - Venus OS may be restarting`);
        // Don't throw the error, just log it
      } else {
        this.logger.error(`❌ Error in handleSignalKUpdate for ${path}:`, err);
        this.logger.error(`❌ Error stack:`, err.stack);
        // Don't throw the error, just log it to prevent higher-level catching
      }
    }
  }

  _isRelevantPath(path) {
    switch (this._internalDeviceType) {
      case 'tank':
        return path.startsWith('tanks.');
      case 'battery':
        return path.startsWith('electrical.batteries.');
      case 'switch':
        return path.startsWith('electrical.switches.');
      case 'environment':
        return path.startsWith('environment.');
      default:
        return false;
    }
  }

  _shouldCreateDeviceForPath(path, value) {
    // Determine if this path/value combination contains "critical data" worth creating a device for
    // This prevents creating devices with fake/placeholder values
    
    switch (this._internalDeviceType) {
      case 'battery':
        // For batteries, create device only when we have meaningful electrical data
        if (path.includes('stateOfCharge') && typeof value === 'number' && !isNaN(value)) {
          return true; // SoC is the most critical battery metric
        }
        if (path.includes('voltage') && typeof value === 'number' && !isNaN(value) && value > 5.0) {
          return true; // Voltage above 5V indicates real battery data
        }
        if (path.includes('current') && typeof value === 'number' && !isNaN(value)) {
          return true; // Any real current measurement is meaningful
        }
        return false; // Don't create for capacity, temperature, etc. without core electrical data
        
      case 'tank':
        // For tanks, create device when we have level or capacity data
        if (path.includes('currentLevel') && typeof value === 'number' && !isNaN(value)) {
          return true; // Tank level is the primary metric
        }
        if (path.includes('capacity') && typeof value === 'number' && !isNaN(value) && value > 0) {
          return true; // Valid capacity indicates a real tank
        }
        return false; // Don't create for just voltage readings or names
        
      case 'switch':
        // For switches, create device when we have state data
        if (path.includes('state') && typeof value === 'boolean') {
          return true; // Switch state is the primary metric
        }
        if (path.includes('dimmingLevel') && typeof value === 'number' && !isNaN(value)) {
          return true; // Dimming level indicates a real controllable device
        }
        return false; // Don't create for position or name without state
        
      case 'environment':
        // For environment sensors, create device when we have sensor readings
        if (path.includes('temperature') && typeof value === 'number' && !isNaN(value)) {
          return true; // Temperature reading indicates a real sensor
        }
        if ((path.includes('humidity') || path.includes('relativeHumidity')) && typeof value === 'number' && !isNaN(value)) {
          return true; // Humidity reading indicates a real sensor
        }
        return false;
        
      default:
        return true; // For unknown device types, use the old behavior
    }
  }

  async _handleDeviceSpecificUpdate(path, value, deviceService, deviceInstance) {
    const deviceName = deviceInstance.name;
    
    switch (this._internalDeviceType) {
      case 'tank':
        await this._handleTankUpdate(path, value, deviceService, deviceName);
        break;
      case 'battery':
        await this._handleBatteryUpdate(path, value, deviceService, deviceName);
        break;
      case 'switch':
        await this._handleSwitchUpdate(path, value, deviceService, deviceName);
        break;
      case 'environment':
        await this._handleEnvironmentUpdate(path, value, deviceService, deviceName);
        break;
    }
  }

  async _handleTankUpdate(path, value, deviceService, deviceName) {
    if (path.includes('currentLevel')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const levelPercent = value * 100;
        await deviceService.updateProperty('/Level', levelPercent, 'd', `${deviceName} level`);
        if ("/Capacity" in deviceService.deviceData)
        {
          await deviceService.updateProperty('/Remaining', value * deviceService.deviceData["/Capacity"], 'd', `${deviceName} level`);
        }
        this.emit('dataUpdated', 'Tank Level', `${deviceName}: ${levelPercent.toFixed(1)}%`);
      }
    } else if (path.includes('capacity')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Capacity', value, 'd', `${deviceName} capacity`);
        this.emit('dataUpdated', 'Tank Capacity', `${deviceName}: ${value.toFixed(1)}L`);
      }
    } else if (path.includes('name')) {
      if (typeof value === 'string') {
        await deviceService.updateProperty('/CustomName', value, 's', `${deviceName}`);
        this.emit('dataUpdated', 'Tank Name', `${deviceName}: ${value}`);
      }
    } else if (path.includes('currentVolume')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Volume', value, 'd', `${deviceName} volume`);
        this.emit('dataUpdated', 'Tank Volume', `${deviceName}: ${value.toFixed(1)}L`);
      }
    } else if (path.includes('voltage')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/RawUnit', 'V', 's', `${deviceName} voltage`);
        await deviceService.updateProperty('/RawValue', value, 'd', `${deviceName} voltage`);
        this.emit('dataUpdated', 'Tank Voltage', `${deviceName}: ${value.toFixed(2)}V`);
      }
    }
  }

  async _handleBatteryUpdate(path, value, deviceService, deviceName) {
    // Try multiple ways to get the devicePath
    const devicePath = deviceService.basePath || 
                      deviceService.deviceInstance?.basePath || 
                      null;
    
    // Validate devicePath to prevent undefined history tracking
    if (!devicePath || devicePath === 'undefined' || devicePath === 'null') {
      this.logger.error(`Invalid devicePath in battery update for ${deviceName}: ${devicePath}`);
      this.logger.error(`DeviceService basePath: ${deviceService.basePath}`);
      this.logger.error(`DeviceInstance basePath: ${deviceService.deviceInstance?.basePath}`);
      this.logger.error(`DeviceInstance object: ${JSON.stringify(deviceService.deviceInstance)}`);
      return;
    }
    
    if (path.includes('voltage')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Dc/0/Voltage', value, 'd', `${deviceName} voltage`);
        this.emit('dataUpdated', 'Battery Voltage', `${deviceName}: ${value.toFixed(2)}V`);
        
        // Update history with current values
        const current = this._getCurrentSignalKValue(`${devicePath}.current`);
        const power = this._getCurrentSignalKValue(`${devicePath}.power`);
        const history = await this.updateHistoryData(devicePath, value, current, power);
        
        // Update history properties on Venus OS (only if history data is available)
        if (history) {
          await this._updateHistoryProperties(deviceService, history);
        }
        // Calculate power if we have both voltage and current
        await this._calculateAndUpdatePower(deviceService, deviceName);
        
        // Only trigger system service updates for battery monitors (BMV)
        if (this._internalDeviceType === 'battery') {
          await this._notifySystemService(deviceService, deviceName);
          await this._triggerSystemServiceRefresh(deviceService, deviceName);
        }
      }
    } else if (path.includes('current')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Dc/0/Current', value, 'd', `${deviceName} current`);
        this.emit('dataUpdated', 'Battery Current', `${deviceName}: ${value.toFixed(1)}A`);
        
        // Update history with current values
        const voltage = this._getCurrentSignalKValue(`${devicePath}.voltage`);
        const power = this._getCurrentSignalKValue(`${devicePath}.power`);
        const history = await this.updateHistoryData(devicePath, voltage, value, power);
        
        // Update history properties on Venus OS (only if history data is available)
        if (history) {
          await this._updateHistoryProperties(deviceService, history);
        }
        
        // Calculate power if we have both voltage and current
        await this._calculateAndUpdatePower(deviceService, deviceName);
        
        // Only trigger system service updates for battery monitors (BMV)
        if (this._internalDeviceType === 'battery') {
          await this._notifySystemService(deviceService, deviceName);
          await this._triggerSystemServiceRefresh(deviceService, deviceName);
        }
      }
    } else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
      if (typeof value === 'number' && !isNaN(value)) {
        const socPercent = value > 1 ? value : value * 100;
        await deviceService.updateProperty('/Soc', socPercent, 'd', `${deviceName} state of charge`);
        this.emit('dataUpdated', 'Battery SoC', `${deviceName}: ${socPercent.toFixed(1)}%`);
        
        // Update battery dummy data (especially consumed Ah based on SOC)
        await this._updateBatteryDummyData(deviceService, deviceName);
        
        // This is critical - trigger system service update when SOC changes for BMV
        if (this._internalDeviceType === 'battery') {
          await this._notifySystemService(deviceService, deviceName);
          await this._triggerSystemServiceRefresh(deviceService, deviceName);
        }
      }
    } else if (path.includes('timeRemaining')) {
      if (typeof value === 'number' && !isNaN(value) && value !== null) {
        // timeRemaining is in seconds, convert to Venus OS format
        let timeToGoSeconds = Math.round(value);
        
        // Log the conversion for debugging
        const hours = Math.floor(timeToGoSeconds / 3600);
        const minutes = Math.floor((timeToGoSeconds % 3600) / 60);
                
        // Use integer type as per Victron specification
        await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', `${deviceName} time to go`);
        this.emit('dataUpdated', 'Battery Time to Go', `${deviceName}: ${hours}h ${minutes}m`);
      } else {
        // Ignoring null/invalid timeRemaining value
      }
    } else if (path.includes('capacity') && !path.includes('state')) {
      if (typeof value === 'number' && !isNaN(value)) {
        // Signal K capacity is in Joules, convert to Ah: Joules / (Voltage * 3600)
        const currentVoltage = deviceService.deviceData['/Dc/0/Voltage'];
        let capacityAh;
        
        if (currentVoltage && typeof currentVoltage === 'number' && currentVoltage > 0) {
          capacityAh = value / (currentVoltage * 3600);
          this.logger.debug(`🔋 Capacity conversion: ${value}J ÷ (${currentVoltage}V × 3600) = ${capacityAh.toFixed(1)}Ah`);
        } else {
          // Fallback: use typical 12V if voltage not available
          capacityAh = value / (12 * 3600);
          this.logger.debug(`🔋 Capacity conversion (12V fallback): ${value}J ÷ (12V × 3600) = ${capacityAh.toFixed(1)}Ah`);
        }
        
        await deviceService.updateProperty('/Capacity', capacityAh, 'd', `${deviceName} capacity`);
        this.emit('dataUpdated', 'Battery Capacity', `${deviceName}: ${capacityAh.toFixed(1)}Ah`);
        
        // Update battery dummy data with new capacity
        await this._updateBatteryDummyData(deviceService, deviceName);
      }
    } else if (path.includes('consumed')) {
      if (typeof value === 'number' && !isNaN(value)) {
        // Consumed amphours
        await deviceService.updateProperty('/ConsumedAmphours', value, 'd', `${deviceName} consumed`);
        this.emit('dataUpdated', 'Battery Consumed', `${deviceName}: ${value.toFixed(1)}Ah`);
      }
    } else if (path.includes('power')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Dc/0/Power', value, 'd', `${deviceName} power`);
        this.emit('dataUpdated', 'Battery Power', `${deviceName}: ${value.toFixed(1)}W`);
      }
    } else if (path.includes('temperature')) {
      if (typeof value === 'number' && !isNaN(value)) {
        let tempCelsius;
        
        // Convert temperature from Kelvin to Celsius if needed
        // SignalK typically uses Kelvin for temperatures
        // Normal battery temperatures are -40°C to +80°C (-40°F to +176°F)
        // In Kelvin: 233K to 353K
        if (value > 100) {
          // Likely Kelvin (anything above 100 is probably Kelvin)
          tempCelsius = value - 273.15;
        } else {
          // Likely already in Celsius
          tempCelsius = value;
        }
        
        // Sanity check for reasonable battery temperatures
        if (tempCelsius < -50 || tempCelsius > 100) {
          this.logger.warn(`⚠️ Battery temperature seems unreasonable: ${tempCelsius.toFixed(1)}°C (from ${value})`);
        }
        
        await deviceService.updateProperty('/Dc/0/Temperature', tempCelsius, 'd', `${deviceName} temperature`);
        this.emit('dataUpdated', 'Battery Temperature', `${deviceName}: ${tempCelsius.toFixed(1)}°C`);
      }
    } else {
      // Unhandled battery path - could log for debugging if needed
    }
  }

  async _handleSwitchUpdate(path, value, deviceService, deviceName) {
    if (path.includes('state')) {
      if (typeof value === 'boolean') {
        const stateValue = value ? 1 : 0;
        await deviceService.updateProperty('/State', stateValue, 'i', `${deviceName} state`);
        this.emit('dataUpdated', 'Switch State', `${deviceName}: ${value ? 'ON' : 'OFF'}`);
      }
    } else if (path.includes('dimmingLevel')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const levelPercent = value > 1 ? value : value * 100;
        await deviceService.updateProperty('/DimmingLevel', levelPercent, 'i', `${deviceName} dimming level`);
        this.emit('dataUpdated', 'Switch Dimming', `${deviceName}: ${levelPercent.toFixed(0)}%`);
      }
    } else if (path.includes('position')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Position', value, 'i', `${deviceName} position`);
        this.emit('dataUpdated', 'Switch Position', `${deviceName}: ${value}`);
      }
    }
  }

  async _handleEnvironmentUpdate(path, value, deviceService, deviceName) {
    if (path.includes('temperature')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const tempCelsius = value > 200 ? value - 273.15 : value; // Convert from Kelvin if needed
        await deviceService.updateProperty('/Temperature', tempCelsius, 'd', `${deviceName} temperature`);
        this.emit('dataUpdated', 'Environment Temperature', `${deviceName}: ${tempCelsius.toFixed(1)}°C`);
      }
    } else if (path.includes('humidity') || path.includes('relativeHumidity')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const humidityPercent = value > 1 ? value : value * 100;
        this.logger.debug(`Environment ${deviceName}: Updating /Humidity = ${humidityPercent.toFixed(1)}%`);
        await deviceService.updateProperty('/Humidity', humidityPercent, 'd', `${deviceName} humidity`);
        this.emit('dataUpdated', 'Environment Humidity', `${deviceName}: ${humidityPercent.toFixed(1)}%`);
      }
    }
  }

  // Start periodic history updates to ensure consumption tracking continues
  // even when no Signal K updates are coming in (e.g., solar disconnected)
  startPeriodicHistoryUpdates() {
    // Update history every 60 seconds for all active battery devices
    this.historyUpdateInterval = setInterval(() => {
      this.updateAllBatteryHistories();
    }, 60000); // 60 seconds
    
    this.logger.debug('Started periodic history updates (60s interval)');
  }
  
  // Stop periodic history updates
  stopPeriodicHistoryUpdates() {
    if (this.historyUpdateInterval) {
      clearInterval(this.historyUpdateInterval);
      this.historyUpdateInterval = null;
      this.logger.debug('Stopped periodic history updates');
    }
  }
  
  // Update history for all battery devices using their last known values
  async updateAllBatteryHistories() {
    for (const [devicePath, deviceService] of this.deviceServices) {
      if (this._internalDeviceType === 'battery') {
        // Get last known values from the device service
        const voltage = deviceService.deviceData['/Dc/0/Voltage'];
        const current = deviceService.deviceData['/Dc/0/Current'];
        const power = deviceService.deviceData['/Dc/0/Power'];
        
        // Only update if we have valid voltage and current
        if (typeof voltage === 'number' && !isNaN(voltage) &&
            typeof current === 'number' && !isNaN(current)) {
          
          this.logger.debug(`Periodic history update for ${devicePath}: V=${voltage.toFixed(2)}V, I=${current.toFixed(2)}A, Solar=${this._getSolarCurrent().toFixed(1)}A, Alt=${this._getAlternatorCurrent().toFixed(1)}A`);
          
          const history = await this.updateHistoryData(devicePath, voltage, current, power);
          
          // Update history properties on Venus OS if available
          if (history) {
            this._updateHistoryProperties(deviceService, history).catch(error => {
              this.logger.error(`Failed to update history properties for ${devicePath}: ${error.message}`);
            });
          }
        }
      }
    }
  }

  async disconnect() {
    // Save history data before disconnecting
    await this.saveHistoryData();
    
    // Stop periodic updates
    this.stopPeriodicHistoryUpdates();
    
    // Stop periodic saving
    if (this.historyPersistence) {
      await this.historyPersistence.stopPeriodicSaving(
        this.historyData,
        this.energyAccumulators,
        this.lastUpdateTime
      );
    }
    
    // Disconnect individual device services
    for (const deviceService of this.deviceServices.values()) {
      if (deviceService && typeof deviceService.disconnect === 'function') {
        try {
          deviceService.disconnect();
        } catch (err) {
          // Ignore disconnect errors
        }
      }
    }
    
    // Disconnect the main bus
    if (this.bus) {
      try {
        this.bus.end();
      } catch (err) {
        // Ignore disconnect errors
      }
    }
    
    this.bus = null;
    this.deviceInstances.clear();
    this.deviceServices.clear();
    this.exportedInterfaces.clear();
  }

  /**
   * Update history properties on Venus OS D-Bus
   */
  async _updateHistoryProperties(deviceService, history) {
    // Safety check
    if (!history || typeof history !== 'object') {
      this.logger.debug('No history data available for updating Venus OS properties');
      return;
    }
    
    try {
      // Validate all values before sending to prevent NaN errors
      const dischargedEnergy = isNaN(history.dischargedEnergy) ? 0 : (history.dischargedEnergy / 1000);
      const chargedEnergy = isNaN(history.chargedEnergy) ? 0 : (history.chargedEnergy / 1000);
      const totalAh = isNaN(history.totalAhDrawn) ? 0 : history.totalAhDrawn;
      
      // Update energy history properties (in kWh)
      await deviceService.updateProperty('/History/DischargedEnergy', 
        dischargedEnergy, 'd', 'Total discharged energy');
      await deviceService.updateProperty('/History/ChargedEnergy', 
        chargedEnergy, 'd', 'Total charged energy');
      
      // Update current history in Ah
      await deviceService.updateProperty('/History/TotalAhDrawn', 
        totalAh, 'd', 'Total Ah drawn');
      
      // Only update voltage history if we have meaningful values
      // Skip initial default values that haven't been updated with real data
      const minimumVoltage = history.minimumVoltage;
      const maximumVoltage = history.maximumVoltage;
      
      // Check if we have actual voltage tracking happening (not just initial values)
      // We consider voltage data "real" if:
      // 1. We have actual min/max voltage values (not null) - this means real voltage data was received
      // 2. AND the values are in reasonable battery voltage range (5V-50V)
      const hasRealVoltageData = (minimumVoltage !== null && maximumVoltage !== null);
      
      // Only set voltage history if we have real voltage data and values are reasonable
      if (hasRealVoltageData) {
        if (minimumVoltage > 5.0 && minimumVoltage < 50.0) {
          await deviceService.updateProperty('/History/MinimumVoltage', 
            minimumVoltage, 'd', 'Minimum voltage');
        }
        
        if (maximumVoltage > 5.0 && maximumVoltage < 50.0) {
          await deviceService.updateProperty('/History/MaximumVoltage', 
            maximumVoltage, 'd', 'Maximum voltage');
        }
      }
        
    } catch (error) {
      this.emit('error', `Failed to update history properties: ${error.message}`);
    }
  }

  async _calculateAndUpdatePower(deviceService, deviceName) {
    // Calculate power from voltage and current if both are available
    const voltage = deviceService.deviceData['/Dc/0/Voltage'];
    const current = deviceService.deviceData['/Dc/0/Current'];
    
    if (typeof voltage === 'number' && typeof current === 'number' && !isNaN(voltage) && !isNaN(current)) {
      const power = voltage * current;
      await deviceService.updateProperty('/Dc/0/Power', power, 'd', `${deviceName} power`);
      this.emit('dataUpdated', 'Battery Power', `${deviceName}: ${power.toFixed(1)}W`);
    }
  }

  async _updateBatteryDummyData(deviceService, deviceName) {
    // Only update dummy data for battery devices
    if (this._internalDeviceType !== 'battery') {
      return;
    }
    
    // Update dummy data for values that might not be coming from Signal K
    
    // Check if device service is connected
    if (!deviceService.isConnected) {
      this.logger.warn(`Device service for ${deviceName} is not connected - skipping dummy data update`);
      return;
    }
    
    // Get current values from the device service
    const currentSoc = deviceService.deviceData['/Soc'];
    const capacity = deviceService.deviceData['/Capacity'];
    const current = deviceService.deviceData['/Dc/0/Current'];
    const voltage = deviceService.deviceData['/Dc/0/Voltage'];
    
    // Only update consumed amp hours if we have SOC and capacity (from device or settings)
    if (typeof currentSoc === 'number' && !isNaN(currentSoc)) {
      // Use device capacity if available, otherwise fall back to settings
      let workingCapacity = capacity;
      if (!workingCapacity && this.settings.batteryCapacity) {
        workingCapacity = this.settings.batteryCapacity;
      }
      
      if (typeof workingCapacity === 'number' && !isNaN(workingCapacity)) {
        // Calculate consumed Ah based on SOC: consumed = capacity * (100 - SOC) / 100
        const consumedAh = workingCapacity * (100 - currentSoc) / 100;
        try {
          await deviceService.updateProperty('/ConsumedAmphours', consumedAh, 'd', `${deviceName} consumed Ah`);
        } catch (err) {
          if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
            this.logger.debug(`Connection lost while updating consumed Ah for ${deviceName}`);
          } else {
            this.logger.error(`Error updating consumed Ah for ${deviceName}:`, err);
          }
        }
      }
    }
    
    // Update voltage tracking for system service compatibility
    if (typeof voltage === 'number' && !isNaN(voltage)) {
      try {
        const currentMinVoltage = deviceService.deviceData['/History/MinimumVoltage'] || voltage;
        const currentMaxVoltage = deviceService.deviceData['/History/MaximumVoltage'] || voltage;
        
        // Update min/max voltage tracking
        if (voltage < currentMinVoltage) {
          await deviceService.updateProperty('/History/MinimumVoltage', voltage, 'd', `${deviceName} minimum voltage`);
        }
        if (voltage > currentMaxVoltage) {
          await deviceService.updateProperty('/History/MaximumVoltage', voltage, 'd', `${deviceName} maximum voltage`);
        }
        
        // Update mid voltage (can be same as main voltage for single battery systems)
        await deviceService.updateProperty('/Dc/0/MidVoltage', voltage, 'd', `${deviceName} mid voltage`);
        
        // NOTE: Mid voltage deviation removed - only set if we have real multi-cell data
      } catch (err) {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
          this.logger.debug(`Connection lost while updating voltage tracking for ${deviceName}`);
        } else {
          this.logger.error(`Error updating voltage tracking for ${deviceName}:`, err);
        }
      }
    }
    
    // Update time to go based on current consumption or charge time
    // Only calculate if Signal K hasn't provided timeRemaining data
    if (typeof current === 'number' && !isNaN(current) && current !== 0 && 
        typeof currentSoc === 'number') {
      
      // Use configured battery capacity if device capacity is not available
      let workingCapacity = capacity;
      if (!workingCapacity && this.settings.batteryCapacity) {
        workingCapacity = this.settings.batteryCapacity;
      }
      
      if (typeof workingCapacity === 'number' && !isNaN(workingCapacity)) {
        
        // Find the basePath for this deviceService to check Signal K timeRemaining
        let basePath = null;
        for (const [path, service] of this.deviceServices.entries()) {
          if (service === deviceService) {
            basePath = path;
            break;
          }
        }
        
        if (basePath) {
          // Check if Signal K has provided timeRemaining data for this battery
          const timeRemainingPath = `${basePath}.capacity.timeRemaining`;
          const signalKTimeRemaining = this._getCurrentSignalKValue(timeRemainingPath);
          
          // Extract numeric value from Signal K response (might be wrapped in object)
          let timeRemainingValue = null;
          
          if (signalKTimeRemaining !== null && signalKTimeRemaining !== undefined) {
            if (typeof signalKTimeRemaining === 'number') {
              timeRemainingValue = signalKTimeRemaining;
            } else if (typeof signalKTimeRemaining === 'object') {
              // Try multiple common Signal K object patterns
              if (signalKTimeRemaining.value !== undefined) {
                timeRemainingValue = signalKTimeRemaining.value;
              } else if (signalKTimeRemaining.val !== undefined) {
                timeRemainingValue = signalKTimeRemaining.val;
              } else if (signalKTimeRemaining.v !== undefined) {
                timeRemainingValue = signalKTimeRemaining.v;
              } else if (typeof signalKTimeRemaining.valueOf === 'function') {
                const extracted = signalKTimeRemaining.valueOf();
                if (typeof extracted === 'number') {
                  timeRemainingValue = extracted;
                }
              }
            }
          }
          
          const hasSignalKTimeToGo = typeof timeRemainingValue === 'number' && !isNaN(timeRemainingValue) && timeRemainingValue !== null && timeRemainingValue > 0;
          
          // Calculate if Signal K hasn't provided timeRemaining
          const shouldCalculate = !hasSignalKTimeToGo;
          
          let timeToGoSeconds;
          
          if (shouldCalculate) {
            // Calculate our own TTG when Signal K doesn't provide timeRemaining
            if (current < 0) {
              // Battery is discharging - calculate time until empty (fallback when Signal K doesn't provide timeRemaining)
              const remainingCapacity = workingCapacity * (currentSoc / 100);
              const timeToGoHours = remainingCapacity / Math.abs(current);
              timeToGoSeconds = Math.round(timeToGoHours * 3600);
            } else {
              // Battery is charging - calculate time to 100% SoC
              const remainingCapacityToFull = workingCapacity * ((100 - currentSoc) / 100);
              const chargeTimeHours = remainingCapacityToFull / current;
              timeToGoSeconds = Math.round(chargeTimeHours * 3600);
            }
          } else {
            // Use Signal K provided timeRemaining value
            timeToGoSeconds = Math.round(timeRemainingValue);
          }
          
          try {
            await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', `${deviceName} time to go`);
          } catch (err) {
            if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
              this.logger.debug(`Connection lost while updating time to go for ${deviceName}`);
            } else {
              this.logger.error(`🔋 TTG calculation - Error updating /TimeToGo:`, err);
            }
          }
        }
      }
    }
    // NOTE: We no longer calculate fake time to go values without real current data
    // This prevents generating misleading information for Venus OS
    
    // NOTE: We no longer generate fake temperature data
    // If a battery doesn't provide temperature, Venus OS will simply not show temperature data
    // This is much better than showing fake values that could mislead users
  }

  async _notifySystemService(deviceService, deviceName) {
    // Only run for battery services - simplified Venus OS system service refresh
    if (this._internalDeviceType !== 'battery') {
      return;
    }
    
    try {
      // Basic state updates to wake up system service - minimal approach
      await deviceService.updateProperty('/Connected', 1, 'i', `${deviceName} connected`);
      await deviceService.updateProperty('/State', 1, 'i', `${deviceName} active`);
      await deviceService.updateProperty('/System/BatteryService', 1, 'i', `${deviceName} battery service active`);
      await deviceService.updateProperty('/DeviceType', 512, 'i', `${deviceName} device type`);
      
    } catch (err) {
      if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
        this.logger.debug(`Connection lost while notifying system service for ${deviceName}`);
      } else {
        this.logger.error(`Error notifying system service for ${deviceName}:`, err);
      }
    }
  }

  async _triggerSystemServiceRefresh(deviceService, deviceName) {
    // Only run for battery services - rate-limited D-Bus signal refresh
    if (this._internalDeviceType !== 'battery') {
      return;
    }
    
    const now = Date.now();
    const lastRefresh = this._lastSystemRefresh || 0;
    
    // Rate limit: only refresh once every 2 seconds to prevent spam
    if (now - lastRefresh < 2000) {
      return;
    }
    
    this._lastSystemRefresh = now;
    
    try {
      // Get current values from deviceData - NO DEFAULT VALUES!
      // Only update if we have real values in deviceData
      const socValue = deviceService.deviceData['/Soc'];
      const currentValue = deviceService.deviceData['/Dc/0/Current'];
      const voltageValue = deviceService.deviceData['/Dc/0/Voltage'];

      // Only update the core BMV values if we have real data
      // This prevents sending fake default values to Venus OS
      if (typeof socValue === 'number' && !isNaN(socValue)) {
        await deviceService.updateProperty('/Soc', socValue, 'd', `${deviceName} state of charge`);
      }
      if (typeof currentValue === 'number' && !isNaN(currentValue)) {
        await deviceService.updateProperty('/Dc/0/Current', currentValue, 'd', `${deviceName} current`);
      }
      if (typeof voltageValue === 'number' && !isNaN(voltageValue)) {
        await deviceService.updateProperty('/Dc/0/Voltage', voltageValue, 'd', `${deviceName} voltage`);
      }
      
    } catch (err) {
      this.logger.error(`Error in system service refresh for ${deviceName}:`, err);
    }
  }
}
