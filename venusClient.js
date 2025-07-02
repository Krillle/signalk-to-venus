import dbus from 'dbus-native';
import { addVictronInterfaces } from 'dbus-victron-virtual';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.victronInterface = null;
    this.lastInitAttempt = 0;
    this.deviceData = {};
    this.instanceId = this._getDeviceInstance(deviceType);
    this.switchIndex = 0; // For unique switch indexing (switches only)
    this.switchInstances = new Map(); // Track switch instances by Signal K path
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

  _getSwitchName(path) {
    // Extract switch name from Signal K path like electrical.switches.navigation.state
    const pathParts = path.split('.');
    if (pathParts.length < 3) return 'Switch';
    
    // Use the switch name from the path
    const switchName = pathParts[2];
    
    // Convert camelCase to proper names
    return switchName.charAt(0).toUpperCase() + switchName.slice(1).replace(/([A-Z])/g, ' $1');
  }

  _getOrCreateSwitchInstance(path) {
    // Get base path without the property (state or dimmingLevel)
    const basePath = path.replace(/\.(state|dimmingLevel)$/, '');
    
    if (!this.switchInstances.has(basePath)) {
      this.switchInstances.set(basePath, {
        index: this.switchIndex++,
        name: this._getSwitchName(path),
        state: 0,
        dimmingLevel: 0
      });
    }
    
    return this.switchInstances.get(basePath);
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
    // Create proper Victron service declaration
    const baseDeclaration = {
      name: this._getServiceName(),
      properties: {
        'DeviceInstance': { type: 'i', default: this.instanceId }
      }
    };

    // Add device-specific properties according to Victron D-Bus spec
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
            // Note: Switch properties will be added dynamically as switches are discovered
            // Each switch gets its own set of properties like Switch/0/State, Switch/0/DimmingLevel
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
      // Create D-Bus connection (required by dbus-victron-virtual)
      this.bus = dbus.createClient({
        // Connect to system bus socket for Venus OS
        socket: process.env.DBUS_SESSION_BUS_ADDRESS?.includes('system_bus_socket') 
          ? '/var/run/dbus/system_bus_socket' 
          : undefined,
        authMethods: ['ANONYMOUS']
      });

      // Setup Victron interfaces with proper bus connection
      const declaration = this._getDeclaration();
      const definition = this._getDefinition();

      // Use the correct API: addVictronInterfaces(bus, declaration, definition, add_defaults, emitCallback)
      const { emitItemsChanged, warnings } = addVictronInterfaces(
        this.bus,
        declaration,
        definition,
        true, // add defaults (Mgmt/Connection, ProductId, etc.)
        (name, args) => {
          // Handle D-Bus events (ItemsChanged, etc.)
          if (name === 'ItemsChanged') {
            this.emit('itemsChanged', args);
          }
        }
      );

      this.victronInterface = { emitItemsChanged };
      this.deviceData = definition;

      // Log any warnings from the library
      if (warnings && warnings.length > 0) {
        // Only log warnings in development, not in production
      }

    } catch (err) {
      // Convert errors to more user-friendly messages
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        throw new Error(`Cannot connect to Venus OS D-Bus - ${err.code}. Ensure running on Venus OS or with proper D-Bus setup.`);
      } else if (err.message && err.message.includes('timeout')) {
        throw new Error(`Connection timeout to Venus OS D-Bus`);
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

    // Emit ItemsChanged to notify Venus OS of updates
    if (this.victronInterface && this.victronInterface.emitItemsChanged) {
      this.victronInterface.emitItemsChanged();
    }

    this.emit('dataUpdated', 'Battery', `${voltage.toFixed(1)}V ${current.toFixed(1)}A`);
  }

  async _handleTankUpdate(path, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || !isFinite(numValue)) {
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

    // Emit ItemsChanged to notify Venus OS of updates
    if (this.victronInterface && this.victronInterface.emitItemsChanged) {
      this.victronInterface.emitItemsChanged();
    }

    this.emit('dataUpdated', 'Tank', `${(level * 100).toFixed(1)}% (${this.deviceData['Remaining'].toFixed(1)}L)`);
  }

  async _handleEnvironmentUpdate(path, value) {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || !isFinite(numValue)) {
      return;
    }

    if (path.includes('temperature')) {
      // Convert Kelvin to Celsius if needed
      let tempC = numValue;
      if (numValue > 200) {
        tempC = numValue - 273.15;
      }
      this.deviceData['Temperature'] = tempC;
      
      // Emit ItemsChanged to notify Venus OS of updates
      if (this.victronInterface && this.victronInterface.emitItemsChanged) {
        this.victronInterface.emitItemsChanged();
      }
      
      this.emit('dataUpdated', 'Temperature', `${tempC.toFixed(1)}°C`);
    } else if (path.includes('humidity')) {
      // Convert 0-1 to 0-100 if needed
      let humidity = numValue;
      if (humidity <= 1) {
        humidity = humidity * 100;
      }
      this.deviceData['Humidity'] = Math.max(0, Math.min(100, humidity));
      
      // Emit ItemsChanged to notify Venus OS of updates
      if (this.victronInterface && this.victronInterface.emitItemsChanged) {
        this.victronInterface.emitItemsChanged();
      }
      
      this.emit('dataUpdated', 'Humidity', `${humidity.toFixed(1)}%`);
    } else if (path.includes('pressure')) {
      this.deviceData['Pressure'] = numValue;
      
      // Emit ItemsChanged to notify Venus OS of updates
      if (this.victronInterface && this.victronInterface.emitItemsChanged) {
        this.victronInterface.emitItemsChanged();
      }
      
      this.emit('dataUpdated', 'Pressure', `${(numValue / 100).toFixed(1)} hPa`);
    }
  }

  async _handleSwitchUpdate(path, value) {
    try {
      // For switches, we need to handle dynamic D-Bus interface creation
      // since dbus-victron-virtual doesn't support dynamic properties well
      
      // Get or create switch instance for this Signal K path
      const switchInstance = this._getOrCreateSwitchInstance(path);
      const switchName = switchInstance.name;
      const index = switchInstance.index;
      
      if (path.includes('state')) {
        // Switch state (0 = off, 1 = on)
        const switchState = value ? 1 : 0;
        switchInstance.state = switchState;
        
        // Export D-Bus interface dynamically (like legacy client)
        const statePath = `/Switch/${index}/State`;
        await this._exportSwitchProperty(statePath, {
          value: switchState,
          type: 'i',
          text: `${switchName} state`
        });
        
        this.emit('dataUpdated', 'Switch State', `${switchName}: ${value ? 'ON' : 'OFF'}`);
        
      } else if (path.includes('dimmingLevel')) {
        // Dimming level (0-1 to 0-100 percentage)
        if (typeof value === 'number' && !isNaN(value)) {
          const dimmingPercent = Math.max(0, Math.min(100, value * 100));
          switchInstance.dimmingLevel = dimmingPercent;
          
          // Export D-Bus interface dynamically
          const dimmingPath = `/Switch/${index}/DimmingLevel`;
          await this._exportSwitchProperty(dimmingPath, {
            value: dimmingPercent,
            type: 'd',
            text: `${switchName} dimming level`
          });
          
          this.emit('dataUpdated', 'Switch Dimming', `${switchName}: ${dimmingPercent.toFixed(1)}%`);
        }
      }
      
    } catch (err) {
      // Silently handle switch update errors
    }
  }

  async _exportSwitchProperty(path, config) {
    // This method dynamically exports D-Bus interfaces for switches
    // Similar to legacy client's _exportProperty method
    if (!this.bus) return;
    
    // Store initial value
    this.deviceData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.deviceData[path] || (config.type === 's' ? '' : 0)];
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.deviceData[path] = actualValue;
        this.emit('valueChanged', path, actualValue);
        return 0; // Success
      },
      GetText: () => {
        return ['s', config.text];
      },
      GetMin: () => {
        if (config.type === 'i' && path.includes('State')) {
          return ['i', 0];
        }
        return ['ai', []]; // null
      },
      GetMax: () => {
        if (config.type === 'i' && path.includes('State')) {
          return ['i', 1];
        } else if (config.type === 'd' && path.includes('DimmingLevel')) {
          return ['d', 100];
        }
        return ['ai', []]; // null
      }
    };

    try {
      this.bus.exportInterface(propertyInterface, path, 'com.victronenergy.BusItem');
    } catch (err) {
      // Silently handle export failures
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
