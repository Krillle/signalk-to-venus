import { VEDBusService } from './vedbus.js';
import { DEVICE_CONFIGS } from './deviceConfigs.js';
import EventEmitter from 'events';

/**
 * Unified VenusClient that uses the central VEDBus service for all device types
 * This replaces the individual device clients with a single, configurable implementation
 */
export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    
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
      this.deviceInstances.set(basePath, null);

      // Create a deterministic index based on the path hash to ensure consistency
      const index = this._generateStableIndex(basePath);
      const deviceInstance = {
        index: index,
        name: this._getDeviceName(path),
        basePath: basePath
      };
      
      // Create device service for this device with its own D-Bus connection
      const deviceService = new VEDBusService(
        `signalk_${deviceInstance.index}`,
        deviceInstance,
        this.settings,
        this.deviceConfig
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
          await deviceService.updateProperty('/Capacity', this.settings.defaultBatteryCapacity, 'd', 'Battery capacity');
          
          // Initialize with realistic dummy data for consumed amp hours based on SOC
          // If battery is at 50% SOC, consumed would be roughly 50% of capacity
          const defaultConsumedAh = this.settings.defaultBatteryCapacity * 0.5; // 50% consumed = 400Ah
          await deviceService.updateProperty('/ConsumedAmphours', defaultConsumedAh, 'd', 'Consumed Ah');
          
          // Initialize time to go with realistic dummy data (8 hours at current consumption)
          const defaultTimeToGo = 8 * 3600; // 8 hours in seconds
          await deviceService.updateProperty('/TimeToGo', defaultTimeToGo, 'i', 'Time to go');
          
          // Initialize basic battery values with defaults if no data yet
          await deviceService.updateProperty('/Dc/0/Voltage', 12.0, 'd', 'Battery voltage');
          await deviceService.updateProperty('/Dc/0/Current', 0.0, 'd', 'Battery current');
          await deviceService.updateProperty('/Dc/0/Power', 0.0, 'd', 'Battery power');
          await deviceService.updateProperty('/Soc', 50.0, 'd', 'State of charge');
          
          // Initialize temperature with realistic dummy data (20°C)
          await deviceService.updateProperty('/Dc/0/Temperature', 20.0, 'd', 'Battery temperature');
          
          // Initialize relay state (normally closed for battery monitors)
          await deviceService.updateProperty('/Relay/0/State', 0, 'i', 'Battery relay state');
          
          // Additional battery monitor specific paths that Venus OS might need
          await deviceService.updateProperty('/System/BatteryService', 1, 'i', 'Battery service');
          break;

        case 'switch':
        case 'environment':
        default:
          break;
      }
      this.deviceServices.set(basePath, deviceService);
      this.deviceInstances.set(basePath, deviceInstance);
    }
    
    // can return null if the device instance is not yet created
    return this.deviceInstances.get(basePath);
  }

  _extractBasePath(path) {
    switch (this._internalDeviceType) {
      case 'tank':
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
        // Skip invalid values silently
        return;
      }
      
      // Check if this path is relevant for our device type
      if (!this._isRelevantPath(path)) {
        return;
      }

      // Initialize if not already done
      const deviceInstance = await this._getOrCreateDeviceInstance(path);
      if (!deviceInstance) return;

      // Get the device service
      const deviceService = this.deviceServices.get(deviceInstance.basePath);
      if (!deviceService) {
        console.error(`No device service found for ${deviceInstance.basePath}`);
        return;
      }
      
      // Handle the update based on device type
      await this._handleDeviceSpecificUpdate(path, value, deviceService, deviceInstance);
      
    } catch (err) {
      throw new Error(err.message);
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
        
        // Update battery dummy data
        await this._updateBatteryDummyData(deviceService, deviceName);
      }
    } else if (path.includes('current')) {
      if (typeof value === 'number' && !isNaN(value)) {
        await deviceService.updateProperty('/Dc/0/Current', value, 'd', `${deviceName} current`);
        this.emit('dataUpdated', 'Battery Current', `${deviceName}: ${value.toFixed(1)}A`);
        
        // Calculate power if we have both voltage and current
        await this._calculateAndUpdatePower(deviceService, deviceName);
        
        // Update battery dummy data (especially time to go based on current)
        await this._updateBatteryDummyData(deviceService, deviceName);
      }
    } else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
      if (typeof value === 'number' && !isNaN(value)) {
        const socPercent = value > 1 ? value : value * 100;
        await deviceService.updateProperty('/Soc', socPercent, 'd', `${deviceName} state of charge`);
        this.emit('dataUpdated', 'Battery SoC', `${deviceName}: ${socPercent.toFixed(1)}%`);
        
        // Update battery dummy data (especially consumed Ah based on SOC)
        await this._updateBatteryDummyData(deviceService, deviceName);
      }
    } else if (path.includes('timeRemaining')) {
      if (typeof value === 'number' && !isNaN(value)) {
        // timeRemaining is in seconds, convert to Venus OS format (integer seconds)
        await deviceService.updateProperty('/TimeToGo', Math.round(value), 'i', `${deviceName} time to go`);
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        this.emit('dataUpdated', 'Battery Time to Go', `${deviceName}: ${hours}h ${minutes}m`);
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
        const tempCelsius = value > 200 ? value - 273.15 : value; // Convert from Kelvin if needed
        await deviceService.updateProperty('/Dc/0/Temperature', tempCelsius, 'd', `${deviceName} temperature`);
        this.emit('dataUpdated', 'Battery Temperature', `${deviceName}: ${tempCelsius.toFixed(1)}°C`);
      }
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
    // Update dummy data for values that might not be coming from Signal K
    
    // Update consumed amp hours based on current SOC if available
    const currentSoc = deviceService.deviceData['/Soc'];
    const capacity = deviceService.deviceData['/Capacity'];
    
    if (typeof currentSoc === 'number' && typeof capacity === 'number' && 
        !isNaN(currentSoc) && !isNaN(capacity)) {
      // Calculate consumed Ah based on SOC: consumed = capacity * (100 - SOC) / 100
      const consumedAh = capacity * (100 - currentSoc) / 100;
      await deviceService.updateProperty('/ConsumedAmphours', consumedAh, 'd', `${deviceName} consumed Ah`);
      this.emit('dataUpdated', 'Battery Consumed', `${deviceName}: ${consumedAh.toFixed(1)}Ah`);
    }
    
    // Update time to go based on current consumption
    const current = deviceService.deviceData['/Dc/0/Current'];
    if (typeof current === 'number' && !isNaN(current) && current > 0) {
      // Calculate time to go based on remaining capacity and current consumption
      const remainingCapacity = capacity * (currentSoc / 100);
      const timeToGoHours = remainingCapacity / current;
      const timeToGoSeconds = Math.round(timeToGoHours * 3600);
      
      await deviceService.updateProperty('/TimeToGo', timeToGoSeconds, 'i', `${deviceName} time to go`);
      const hours = Math.floor(timeToGoSeconds / 3600);
      const minutes = Math.floor((timeToGoSeconds % 3600) / 60);
      this.emit('dataUpdated', 'Battery Time to Go', `${deviceName}: ${hours}h ${minutes}m`);
    } else {
      // If no current data or current is 0 or negative, use a default based on SOC
      let defaultTimeToGo = 8 * 3600; // 8 hours default
      if (typeof currentSoc === 'number' && !isNaN(currentSoc)) {
        // Scale time to go based on SOC: higher SOC = more time remaining
        // At 100% SOC: 20 hours, at 50% SOC: 10 hours, at 20% SOC: 4 hours
        defaultTimeToGo = Math.round((currentSoc / 100) * 20 * 3600);
        defaultTimeToGo = Math.max(defaultTimeToGo, 1800); // Minimum 30 minutes
      }
      await deviceService.updateProperty('/TimeToGo', defaultTimeToGo, 'i', `${deviceName} time to go`);
    }
    
    // Update battery temperature with a realistic value if not provided
    const currentTemp = deviceService.deviceData['/Dc/0/Temperature'];
    if (typeof currentTemp !== 'number' || isNaN(currentTemp) || currentTemp <= 0) {
      // Use a temperature that varies slightly based on current load
      let baseTemp = 20.0; // 20°C base temperature
      if (typeof current === 'number' && !isNaN(current)) {
        // Add 0.1°C per amp of current (batteries warm up under load)
        baseTemp += Math.abs(current) * 0.1;
      }
      await deviceService.updateProperty('/Dc/0/Temperature', baseTemp, 'd', `${deviceName} temperature`);
    }
  }
}
