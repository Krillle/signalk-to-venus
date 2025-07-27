import { VEDBusService } from './vedbus.js';
import { DEVICE_CONFIGS } from './deviceConfigs.js';
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
  }

  // Set Signal K app reference for getting current values
  setSignalKApp(app) {
    this.signalKApp = app;
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
                
                // Calculate initial consumed Ah and time to go if we have SOC and real capacity
                if (currentSoc !== null && typeof currentSoc === 'number') {
                  const socPercent = currentSoc > 1 ? currentSoc : currentSoc * 100;
                  
                  // Only calculate consumed Ah if we have real capacity data from Signal K
                  const capacityPath = `${basePath}.capacity.nominal`;
                  const realCapacity = this.signalKApp.getSelfPath(capacityPath);
                  if (realCapacity && typeof realCapacity === 'number' && realCapacity > 0) {
                    const consumedAh = realCapacity * (100 - socPercent) / 100;
                    await deviceService.updateProperty('/ConsumedAmphours', consumedAh, 'd', 'Consumed Ah');
                    await deviceService.updateProperty('/Capacity', realCapacity, 'd', 'Battery capacity');
                    
                    // Calculate realistic time to go based on SOC and capacity
                    if (currentCurrent !== null && typeof currentCurrent === 'number' && currentCurrent !== 0) {
                      let timeToGoSeconds;
                      
                      if (currentCurrent > 0) {
                        // Battery is discharging - calculate time until empty
                        const remainingCapacity = realCapacity * (socPercent / 100);
                        const timeToGoHours = remainingCapacity / currentCurrent;
                        timeToGoSeconds = Math.round(timeToGoHours * 3600);
                      } else {
                        // Battery is charging - calculate time to 100% SoC
                        // Use configured battery capacity if available, otherwise use Signal K capacity
                        const totalCapacity = this.settings.batteryCapacity || realCapacity;
                        const remainingCapacityToFull = totalCapacity * ((100 - socPercent) / 100);
                        const chargeTimeHours = remainingCapacityToFull / Math.abs(currentCurrent);
                        timeToGoSeconds = Math.round(chargeTimeHours * 3600);
                      }
                      
                      await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', 'Time to go');
                    }
                  }
                }
                
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
            await deviceService.updateProperty('/Info/MaxChargeCurrent', 100, 'i', 'Max charge current');
            await deviceService.updateProperty('/Info/MaxDischargeCurrent', 100, 'i', 'Max discharge current');
            await deviceService.updateProperty('/Info/MaxChargeVoltage', 14.4, 'd', 'Max charge voltage');
            
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
        console.error(`❌ Error creating device instance for ${basePath} (from path: ${path}):`, error);
        console.error(`❌ Error stack:`, error.stack);
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
        console.warn(`⚠️ Timeout waiting for device creation: ${basePath}`);
        return null;
      }
      
      return existing;
    }
  }

  _extractBasePath(path) {
    switch (this._internalDeviceType) {
      case 'tank':
        // Handle tank paths like 'tanks.freshWater.0.capacity' -> 'tanks.freshWater.0'
        // and also 'tanks.freshWater.0.currentLevel' -> 'tanks.freshWater.0'
        return path.replace(/\.(currentLevel|capacity|name|currentVolume|voltage)$/, '');
      case 'battery':
        return path.replace(/\.(voltage|current|stateOfCharge|consumed|timeRemaining|relay|temperature|name|capacity\..*|power)$/, '');
      case 'switch':
        return path.replace(/\.(state|dimmingLevel|position|name)$/, '');
      case 'environment':
        return path.replace(/\.(temperature|humidity|relativeHumidity)$/, '');
      default:
        return path;
    }
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
      const environmentType = parts[1]; // e.g., 'water', 'air', 'inside'
      const sensorType = parts[2]; // e.g., 'temperature', 'humidity'
      
      // Remove camel case and capitalize first letter
      let sensor = environmentType.replace(/([A-Z])/g, ' $1').trim();
      sensor = sensor.charAt(0).toUpperCase() + sensor.slice(1).toLowerCase();
      
      if (sensorType === 'temperature') {
        return `${sensor} Temperature`;
      } else if (sensorType === 'humidity' || sensorType === 'relativeHumidity') {
        return `${sensor} Humidity`;
      } else {
        return `${sensor} ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`;
      }
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

      // Initialize if not already done
      const deviceInstance = await this._getOrCreateDeviceInstance(path);
      if (!deviceInstance) {
        console.error(`Failed to create device instance for ${path}`);
        return;
      }

      // Get the device service
      const deviceService = this.deviceServices.get(deviceInstance.basePath);
      if (!deviceService) {
        console.error(`No device service found for ${deviceInstance.basePath}`);
        return;
      }
      
      // Check if device service is connected and ready for data updates
      if (!deviceService.isConnected) {
        console.warn(`⚠️ RACE CONDITION: Device service ${deviceInstance.basePath} not connected yet - data update ${path} = ${value} will be dropped`);
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
        console.error(`❌ Error in handleSignalKUpdate for ${path}:`, err);
        console.error(`❌ Error stack:`, err.stack);
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
    if (path.includes('voltage')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Dc/0/Voltage', value, 'd', `${deviceName} voltage`);
        this.emit('dataUpdated', 'Battery Voltage', `${deviceName}: ${value.toFixed(2)}V`);
        
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
        // This is battery capacity in Ah - could be from capacity.nominal or similar
        await deviceService.updateProperty('/Capacity', value, 'd', `${deviceName} capacity`);
        this.emit('dataUpdated', 'Battery Capacity', `${deviceName}: ${value.toFixed(1)}Ah`);
        
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
          console.warn(`⚠️ Battery temperature seems unreasonable: ${tempCelsius.toFixed(1)}°C (from ${value})`);
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

  async disconnect() {
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
      console.warn(`Device service for ${deviceName} is not connected - skipping dummy data update`);
      return;
    }
    
    // Get current values from the device service
    const currentSoc = deviceService.deviceData['/Soc'];
    const capacity = deviceService.deviceData['/Capacity'];
    const current = deviceService.deviceData['/Dc/0/Current'];
    const voltage = deviceService.deviceData['/Dc/0/Voltage'];
    
    // Only update consumed amp hours if we have both SOC and capacity
    if (typeof currentSoc === 'number' && typeof capacity === 'number' && 
        !isNaN(currentSoc) && !isNaN(capacity)) {
      // Calculate consumed Ah based on SOC: consumed = capacity * (100 - SOC) / 100
      const consumedAh = capacity * (100 - currentSoc) / 100;
      try {
        await deviceService.updateProperty('/ConsumedAmphours', consumedAh, 'd', `${deviceName} consumed Ah`);
      } catch (err) {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
          this.logger.debug(`Connection lost while updating consumed Ah for ${deviceName}`);
        } else {
          console.error(`Error updating consumed Ah for ${deviceName}:`, err);
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
        
        // Calculate mid voltage deviation (for single battery, this is typically 0)
        await deviceService.updateProperty('/Dc/0/MidVoltageDeviation', 0.0, 'd', `${deviceName} mid voltage deviation`);
      } catch (err) {
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
          this.logger.debug(`Connection lost while updating voltage tracking for ${deviceName}`);
        } else {
          console.error(`Error updating voltage tracking for ${deviceName}:`, err);
        }
      }
    }
    
    // Update time to go based on current consumption or charge time
    // Only calculate if Signal K hasn't provided timeRemaining data
    if (typeof current === 'number' && !isNaN(current) && current !== 0 && 
        typeof capacity === 'number' && typeof currentSoc === 'number') {
      
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
        const signalKTimeRemaining = this._getCurrentSignalKValue(`${basePath}.capacity.timeRemaining`);
        const hasSignalKTimeToGo = typeof signalKTimeRemaining === 'number' && !isNaN(signalKTimeRemaining) && signalKTimeRemaining !== null;
        
        // For discharging: prefer Signal K timeRemaining over our calculation
        // For charging: always calculate since Signal K typically doesn't provide charge time
        // Calculate if Signal K hasn't provided timeRemaining
        const shouldCalculate = !hasSignalKTimeToGo;
        
        let timeToGoSeconds;
        
        if (shouldCalculate) {
          // Calculate our own TTG when Signal K doesn't provide timeRemaining
          if (current > 0) {
            // Battery is discharging - calculate time until empty (fallback when Signal K doesn't provide timeRemaining)
            const remainingCapacity = capacity * (currentSoc / 100);
            const timeToGoHours = remainingCapacity / current;
            timeToGoSeconds = Math.round(timeToGoHours * 3600);
          } else {
            // Battery is charging - calculate time to 100% SoC
            // Use configured battery capacity if available, otherwise use Signal K capacity
            const totalCapacity = this.settings.batteryCapacity || capacity;
            const remainingCapacityToFull = totalCapacity * ((100 - currentSoc) / 100);
            const chargeTimeHours = remainingCapacityToFull / Math.abs(current);
            timeToGoSeconds = Math.round(chargeTimeHours * 3600);
          }
        } else {
          // Use Signal K provided timeRemaining value
          timeToGoSeconds = Math.round(signalKTimeRemaining);
        }
        
        try {
          await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', `${deviceName} time to go`);
        } catch (err) {
          if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
            this.logger.debug(`Connection lost while updating time to go for ${deviceName}`);
          } else {
            console.error(`Error updating time to go for ${deviceName}:`, err);
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
        console.error(`Error notifying system service for ${deviceName}:`, err);
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
      console.error(`Error in system service refresh for ${deviceName}:`, err);
    }
  }
}
