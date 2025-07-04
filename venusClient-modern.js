import dbus from 'dbus-native';
import { addVictronInterfaces } from 'dbus-victron-virtual';
import EventEmitter from 'events';

export class ModernVenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.victronInterface = null;
    this.lastInitAttempt = 0;
    this.deviceData = {};
    this.instanceId = this._getDeviceInstance(deviceType);
  }

  _getDeviceInstance(deviceType) {
    // Use different device instances for different types
    const instances = {
      'batteries': 20,
      'tanks': 21,
      'environment': 22,
      'switches': 23
    };
    return instances[deviceType] || 24;
  }

  _getServiceName() {
    const serviceNames = {
      'batteries': `com.victronenergy.battery.signalk_${this.instanceId}`,
      'tanks': `com.victronenergy.tank.signalk_${this.instanceId}`,
      'environment': `com.victronenergy.temperature.signalk_${this.instanceId}`,
      'switches': `com.victronenergy.switch.signalk_${this.instanceId}`
    };
    return serviceNames[this.deviceType] || `com.victronenergy.${this.deviceType}.signalk_${this.instanceId}`;
  }

  _getDeclaration() {
    const baseDeclaration = {
      name: this._getServiceName(),
      properties: {
        'DeviceInstance': { type: 'i', default: this.instanceId }
      }
    };

    // Add device-specific properties
    switch (this.deviceType) {
      case 'batteries':
        return {
          ...baseDeclaration,
          properties: {
            ...baseDeclaration.properties,
            'Dc/0/Voltage': { type: 'd', format: (v) => `${v?.toFixed(2) || 0} V` },
            'Dc/0/Current': { type: 'd', format: (v) => `${v?.toFixed(2) || 0} A` },
            'Dc/0/Power': { type: 'd', format: (v) => `${v?.toFixed(1) || 0} W` },
            'Soc': { type: 'd', min: 0, max: 100, format: (v) => `${v?.toFixed(1) || 0} %` },
            'TimeToGo': { type: 'd', format: (v) => v ? `${Math.round(v)} s` : '' },
            'Capacity': { type: 'd', format: (v) => `${v?.toFixed(1) || 0} Ah` }
          }
        };

      case 'tanks':
        return {
          ...baseDeclaration,
          properties: {
            ...baseDeclaration.properties,
            'Level': { type: 'd', min: 0, max: 1, format: (v) => `${((v || 0) * 100).toFixed(1)} %` },
            'Capacity': { type: 'd', format: (v) => `${v?.toFixed(1) || 0} L` },
            'Remaining': { type: 'd', format: (v) => `${v?.toFixed(1) || 0} L` },
            'FluidType': { type: 'i', default: 0 } // 0=Fuel, 1=Fresh water, 2=Waste water, 3=Live well, 4=Oil, 5=Black water (sewage)
          }
        };

      case 'environment':
        return {
          ...baseDeclaration,
          properties: {
            ...baseDeclaration.properties,
            'Temperature': { type: 'd', format: (v) => `${v?.toFixed(1) || 0} °C` },
            'Humidity': { type: 'd', min: 0, max: 100, format: (v) => `${v?.toFixed(1) || 0} %` },
            'Pressure': { type: 'd', format: (v) => `${(v ? v / 100 : 0).toFixed(1)} hPa` }
          }
        };

      case 'switches':
        return {
          ...baseDeclaration,
          properties: {
            ...baseDeclaration.properties,
            'State': { type: 'i', min: 0, max: 1, format: (v) => v ? 'On' : 'Off' }
          }
        };

      default:
        return baseDeclaration;
    }
  }

  _getDefinition() {
    const baseDefinition = {
      'DeviceInstance': this.instanceId
    };

    // Initialize with sensible defaults
    switch (this.deviceType) {
      case 'batteries':
        return {
          ...baseDefinition,
          'Dc/0/Voltage': 0,
          'Dc/0/Current': 0,
          'Dc/0/Power': 0,
          'Soc': 0,
          'TimeToGo': null,
          'Capacity': 0
        };

      case 'tanks':
        return {
          ...baseDefinition,
          'Level': 0,
          'Capacity': 0,
          'Remaining': 0,
          'FluidType': 0
        };

      case 'environment':
        return {
          ...baseDefinition,
          'Temperature': 0,
          'Humidity': 0,
          'Pressure': 0
        };

      case 'switches':
        return {
          ...baseDefinition,
          'State': 0
        };

      default:
        return baseDefinition;
    }
  }

  async init() {
    try {
      // Create D-Bus connection
      this.bus = dbus.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });

      // Request service name
      await new Promise((resolve, reject) => {
        this.bus.requestName(this._getServiceName(), 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Setup Victron interfaces
      const declaration = this._getDeclaration();
      const definition = this._getDefinition();

      this.victronInterface = addVictronInterfaces(
        this.bus,
        declaration,
        definition,
        true, // add defaults
        (name, args) => {
          // Handle D-Bus events
          if (name === 'ItemsChanged') {
            this.emit('itemsChanged', args);
          }
        }
      );

      this.deviceData = definition;

    } catch (err) {
      // Convert errors to more user-friendly messages
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to Venus OS at ${this.settings.venusHost}:78 - ${err.code}`);
      } else if (err.message && err.message.includes('timeout')) {
        throw new Error(`Connection timeout to Venus OS at ${this.settings.venusHost}:78`);
      }
      throw err;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        return;
      }

      if (!this.bus || !this.victronInterface) {
        // Only try to initialize once every 30 seconds to avoid spam
        const now = Date.now();
        if (!this.lastInitAttempt || (now - this.lastInitAttempt) > 30000) {
          this.lastInitAttempt = now;
          await this.init();
        } else {
          return;
        }
      }

      // Route to appropriate handler based on device type
      switch (this.deviceType) {
        case 'batteries':
          await this._handleBatteryUpdate(path, value);
          break;
        case 'tanks':
          await this._handleTankUpdate(path, value);
          break;
        case 'environment':
          await this._handleEnvironmentUpdate(path, value);
          break;
        case 'switches':
          await this._handleSwitchUpdate(path, value);
          break;
      }

    } catch (err) {
      throw new Error(`Error updating ${this.deviceType}: ${err.message}`);
    }
  }

  async _handleBatteryUpdate(path, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || !isFinite(numValue)) {
      console.warn(`Invalid battery value for ${path}: ${value}`);
      return;
    }

    if (path.includes('voltage')) {
      this.deviceData['Dc/0/Voltage'] = numValue;
    } else if (path.includes('current')) {
      this.deviceData['Dc/0/Current'] = numValue;
    } else if (path.includes('stateOfCharge')) {
      this.deviceData['Soc'] = numValue * 100; // Convert 0-1 to 0-100
    } else if (path.includes('capacity.nominal')) {
      this.deviceData['Capacity'] = numValue / 3600; // Convert Joules to Ah (approximate)
    }

    // Calculate power
    const voltage = this.deviceData['Dc/0/Voltage'] || 0;
    const current = this.deviceData['Dc/0/Current'] || 0;
    this.deviceData['Dc/0/Power'] = voltage * current;

    this.emit('dataUpdated', 'Battery', `${voltage.toFixed(1)}V ${current.toFixed(1)}A`);
  }

  async _handleTankUpdate(path, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || !isFinite(numValue)) {
      console.warn(`Invalid tank value for ${path}: ${value}`);
      return;
    }

    if (path.includes('currentLevel')) {
      this.deviceData['Level'] = numValue; // Signal K uses 0-1
    } else if (path.includes('capacity')) {
      this.deviceData['Capacity'] = numValue;
    }

    // Calculate remaining
    const level = this.deviceData['Level'] || 0;
    const capacity = this.deviceData['Capacity'] || 0;
    this.deviceData['Remaining'] = level * capacity;

    // Set fluid type based on tank type
    if (path.includes('fuel')) {
      this.deviceData['FluidType'] = 0; // Fuel
    } else if (path.includes('freshWater')) {
      this.deviceData['FluidType'] = 1; // Fresh water
    } else if (path.includes('wasteWater')) {
      this.deviceData['FluidType'] = 2; // Waste water
    } else if (path.includes('blackWater')) {
      this.deviceData['FluidType'] = 5; // Black water
    }

    this.emit('dataUpdated', 'Tank', `${(level * 100).toFixed(1)}% (${this.deviceData['Remaining'].toFixed(1)}L)`);
  }

  async _handleEnvironmentUpdate(path, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || !isFinite(numValue)) {
      console.warn(`Invalid environment value for ${path}: ${value}`);
      return;
    }

    if (path.includes('temperature')) {
      // Convert Kelvin to Celsius if needed
      let tempC = numValue;
      if (numValue > 200) {
        tempC = numValue - 273.15;
      }
      this.deviceData['Temperature'] = tempC;
      this.emit('dataUpdated', 'Temperature', `${tempC.toFixed(1)}°C`);
    } else if (path.includes('humidity')) {
      // Convert 0-1 to 0-100 if needed
      let humidity = numValue;
      if (humidity <= 1) {
        humidity = humidity * 100;
      }
      this.deviceData['Humidity'] = Math.max(0, Math.min(100, humidity));
      this.emit('dataUpdated', 'Humidity', `${humidity.toFixed(1)}%`);
    } else if (path.includes('pressure')) {
      this.deviceData['Pressure'] = numValue;
      this.emit('dataUpdated', 'Pressure', `${(numValue / 100).toFixed(1)} hPa`);
    }
  }

  async _handleSwitchUpdate(path, value) {
    if (path.includes('state')) {
      const state = value ? 1 : 0;
      this.deviceData['State'] = state;
      this.emit('dataUpdated', 'Switch', state ? 'On' : 'Off');
    }
  }

  async disconnect() {
    if (this.bus) {
      try {
        this.bus.end();
      } catch (err) {
        // Ignore disconnect errors
      }
      this.bus = null;
      this.victronInterface = null;
      this.deviceData = {};
    }
  }
}
