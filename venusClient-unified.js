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
    this.deviceConfig = DEVICE_CONFIGS[deviceType];
    
    if (!this.deviceConfig) {
      throw new Error(`Unsupported device type: ${deviceType}. Supported types: ${Object.keys(DEVICE_CONFIGS).join(', ')}`);
    }
    
    this.bus = null;
    this.deviceIndex = 0; // For unique device indexing
    this.deviceCounts = {}; // Track how many devices of each type we have
    this.deviceCreating = new Map(); // Prevent race conditions in device creation
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
      if (this.deviceCreating.has(basePath))
        return;

      this.deviceCreating.set(basePath, true);
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
      this.deviceServices.set(basePath, deviceService);
      this.deviceInstances.set(basePath, deviceInstance);
      this.deviceCreating.delete(basePath);
    }
    
    return this.deviceInstances.get(basePath);
  }

  _extractBasePath(path) {
    switch (this.deviceType) {
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
    switch (this.deviceType) {
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
    if (parts.length >= 3) {
      const tankType = parts[1]; // e.g., 'fuel', 'freshWater', 'wasteWater'
      const tankLocation = parts[2]; // e.g., 'starboard', 'port', 'main'
      
      if (tankType === 'fuel') {
        return `Fuel ${tankLocation}`;
      } else if (tankType === 'freshWater') {
        return tankLocation === 'main' ? 'Freshwater' : `Freshwater ${tankLocation}`;
      } else if (tankType === 'wasteWater') {
        return tankLocation === 'primary' ? 'Wastewater' : `Wastewater ${tankLocation}`;
      } else if (tankType === 'blackWater') {
        return tankLocation === 'primary' ? 'Blackwater' : `Blackwater ${tankLocation}`;
      } else {
        return `${tankType.charAt(0).toUpperCase() + tankType.slice(1)} ${tankLocation}`;
      }
    }
    return 'Unknown Tank';
  }

  _getBatteryName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const batteryLocation = parts[2]; // e.g., 'main', 'house', 'starter'
      return `${batteryLocation.charAt(0).toUpperCase() + batteryLocation.slice(1)} Battery`;
    }
    return 'Unknown Battery';
  }

  _getSwitchName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const switchName = parts[2]; // e.g., 'nav', 'anchor', 'cabinLights'
      // Convert camelCase to Title Case with spaces
      return switchName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
    }
    return 'Unknown Switch';
  }

  _getEnvironmentName(path) {
    const parts = path.split('.');
    if (parts.length >= 3) {
      const environmentType = parts[1]; // e.g., 'water', 'air', 'inside'
      const sensorType = parts[2]; // e.g., 'temperature', 'humidity'
      
      if (sensorType === 'temperature') {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} Temperature`;
      } else if (sensorType === 'humidity' || sensorType === 'relativeHumidity') {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} Humidity`;
      } else {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`;
      }
    }
    return 'Unknown Environment Sensor';
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
    switch (this.deviceType) {
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
    
    switch (this.deviceType) {
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
        const levelPercent = value > 1 ? value : value * 100;
        deviceService.updateProperty('/Level', levelPercent, 'd', `${deviceName} level`);
        this.emit('dataUpdated', 'Tank Level', `${deviceName}: ${levelPercent.toFixed(1)}%`);
      }
    } else if (path.includes('capacity')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Capacity', value, 'd', `${deviceName} capacity`);
        this.emit('dataUpdated', 'Tank Capacity', `${deviceName}: ${value.toFixed(1)}L`);
      }
    } else if (path.includes('name')) {
      if (typeof value === 'string') {
        deviceService.updateProperty('/Name', value, 's', `${deviceName} name`);
        this.emit('dataUpdated', 'Tank Name', `${deviceName}: ${value}`);
      }
    } else if (path.includes('currentVolume')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Volume', value, 'd', `${deviceName} volume`);
        this.emit('dataUpdated', 'Tank Volume', `${deviceName}: ${value.toFixed(1)}L`);
      }
    } else if (path.includes('voltage')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Voltage', value, 'd', `${deviceName} voltage`);
        this.emit('dataUpdated', 'Tank Voltage', `${deviceName}: ${value.toFixed(2)}V`);
      }
    }
  }

  async _handleBatteryUpdate(path, value, deviceService, deviceName) {
    if (path.includes('voltage')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Dc/0/Voltage', value, 'd', `${deviceName} voltage`);
        this.emit('dataUpdated', 'Battery Voltage', `${deviceName}: ${value.toFixed(2)}V`);
      }
    } else if (path.includes('current')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Dc/0/Current', value, 'd', `${deviceName} current`);
        this.emit('dataUpdated', 'Battery Current', `${deviceName}: ${value.toFixed(1)}A`);
      }
    } else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
      if (typeof value === 'number' && !isNaN(value)) {
        const socPercent = value > 1 ? value : value * 100;
        deviceService.updateProperty('/Soc', socPercent, 'd', `${deviceName} state of charge`);
        this.emit('dataUpdated', 'Battery SoC', `${deviceName}: ${socPercent.toFixed(1)}%`);
      }
    } else if (path.includes('power')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Dc/0/Power', value, 'd', `${deviceName} power`);
        this.emit('dataUpdated', 'Battery Power', `${deviceName}: ${value.toFixed(1)}W`);
      }
    } else if (path.includes('temperature')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const tempCelsius = value > 200 ? value - 273.15 : value; // Convert from Kelvin if needed
        deviceService.updateProperty('/Dc/0/Temperature', tempCelsius, 'd', `${deviceName} temperature`);
        this.emit('dataUpdated', 'Battery Temperature', `${deviceName}: ${tempCelsius.toFixed(1)}°C`);
      }
    }
  }

  async _handleSwitchUpdate(path, value, deviceService, deviceName) {
    if (path.includes('state')) {
      if (typeof value === 'boolean') {
        const stateValue = value ? 1 : 0;
        deviceService.updateProperty('/State', stateValue, 'i', `${deviceName} state`);
        this.emit('dataUpdated', 'Switch State', `${deviceName}: ${value ? 'ON' : 'OFF'}`);
      }
    } else if (path.includes('dimmingLevel')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const levelPercent = value > 1 ? value : value * 100;
        deviceService.updateProperty('/DimmingLevel', levelPercent, 'i', `${deviceName} dimming level`);
        this.emit('dataUpdated', 'Switch Dimming', `${deviceName}: ${levelPercent.toFixed(0)}%`);
      }
    } else if (path.includes('position')) {
      if (typeof value === 'number' && !isNaN(value)) {
        deviceService.updateProperty('/Position', value, 'i', `${deviceName} position`);
        this.emit('dataUpdated', 'Switch Position', `${deviceName}: ${value}`);
      }
    }
  }

  async _handleEnvironmentUpdate(path, value, deviceService, deviceName) {
    if (path.includes('temperature')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const tempCelsius = value > 200 ? value - 273.15 : value; // Convert from Kelvin if needed
        deviceService.updateProperty('/Temperature', tempCelsius, 'd', `${deviceName} temperature`);
        this.emit('dataUpdated', 'Environment Temperature', `${deviceName}: ${tempCelsius.toFixed(1)}°C`);
      }
    } else if (path.includes('humidity') || path.includes('relativeHumidity')) {
      if (typeof value === 'number' && !isNaN(value)) {
        const humidityPercent = value > 1 ? value : value * 100;
        deviceService.updateProperty('/Humidity', humidityPercent, 'd', `${deviceName} humidity`);
        this.emit('dataUpdated', 'Environment Humidity', `${deviceName}: ${humidityPercent.toFixed(1)}%`);
      }
    }
  }

  async disconnect() {
    // Disconnect individual device services
    for (const deviceService of this.deviceServices.values()) {
      if (deviceService) {
        deviceService.disconnect();
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
    this.deviceCreating.clear();
    this.exportedInterfaces.clear();
  }
}
