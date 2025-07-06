import dbusNative from 'dbus-native';
import EventEmitter from 'events';

/**
 * VeDbusService - A Node.js implementation of Victron Energy's vedbus.py
 * 
 * This class provides a standardized way to create Venus OS D-Bus services,
 * following the same patterns as the official Python velib library.
 */
export class VeDbusService extends EventEmitter {
  constructor(serviceName, bus = null) {
    super();
    
    this.serviceName = serviceName;
    this.bus = bus;
    this.ownBus = !bus; // Track if we own the bus
    this.items = new Map(); // Store all exported properties
    this.exportedInterfaces = new Set();
    
    // Management properties - these are always present
    this.mgmtProps = {
      '/Mgmt/ProcessName': { value: 'signalk-to-venus', writable: false },
      '/Mgmt/ProcessVersion': { value: '1.0.12', writable: false },
      '/Mgmt/Connection': { value: 'D-Bus', writable: false }
    };
    
    // Device identification properties
    this.deviceProps = {
      '/ProductName': { value: 'SignalK Device', writable: false },
      '/ProductId': { value: 0xFFFF, writable: false },
      '/FirmwareVersion': { value: '1.0.12', writable: false },
      '/HardwareVersion': { value: '1.0', writable: false },
      '/Connected': { value: 1, writable: false }
    };
  }

  /**
   * Initialize the D-Bus service
   */
  async init(venusHost = 'localhost', port = 78) {
    if (!this.bus) {
      // Create our own D-Bus connection
      this.bus = dbusNative.createClient({
        host: venusHost,
        port: port,
        authMethods: ['ANONYMOUS']
      });
      this.ownBus = true;
    }

    // Request the service name
    await this._requestServiceName();
    
    // Export management and device properties
    this._exportMgmtProperties();
    this._exportDeviceProperties();
    
    // Export root interface
    this._exportRootInterface();
    
    this.emit('connected');
  }

  /**
   * Add a property to the service
   */
  addProperty(path, value, options = {}) {
    const property = {
      value: value,
      type: this._getDbusType(value),
      writable: options.writable || false,
      text: options.text || this._pathToText(path),
      min: options.min,
      max: options.max,
      onchange: options.onchange
    };
    
    this.items.set(path, property);
    
    if (this.bus) {
      this._exportProperty(path, property);
    }
    
    return this;
  }

  /**
   * Update a property value
   */
  setValue(path, value) {
    if (!this.items.has(path)) {
      throw new Error(`Property ${path} not found`);
    }
    
    const property = this.items.get(path);
    const oldValue = property.value;
    property.value = value;
    property.type = this._getDbusType(value);
    
    // Emit change event
    this.emit('propertyChanged', path, value, oldValue);
    
    // Call onchange handler if present
    if (property.onchange) {
      property.onchange(path, value, oldValue);
    }
    
    return this;
  }

  /**
   * Get a property value
   */
  getValue(path) {
    const property = this.items.get(path);
    return property ? property.value : undefined;
  }

  /**
   * Register the service with Venus OS Settings API
   */
  async registerInSettings(deviceClass, deviceInstance, customName = null) {
    if (!this.bus) {
      throw new Error('Service not initialized');
    }

    // Skip registration if this is a mock bus (for testing)
    if (!this.bus.invoke || typeof this.bus.invoke !== 'function') {
      console.log('Skipping Settings API registration for mock bus');
      this.setValue('/DeviceInstance', deviceInstance);
      this.emit('settingsRegistered', deviceInstance);
      return deviceInstance;
    }

    const serviceName = this.serviceName.replace(/^com\.victronenergy\./, '');
    const settingsName = `signalk_${serviceName}_${deviceInstance}`;
    const proposedInstance = `${deviceClass}:${deviceInstance}`;
    
    const settingsArray = [
      [
        ['path', ['s', `/Settings/Devices/${settingsName}/ClassAndVrmInstance`]],
        ['default', ['s', proposedInstance]],
        ['type', ['s', 's']],
        ['description', ['s', 'Class and VRM instance']]
      ]
    ];
    
    if (customName) {
      settingsArray.push([
        ['path', ['s', `/Settings/Devices/${settingsName}/CustomName`]],
        ['default', ['s', customName]],
        ['type', ['s', 's']],
        ['description', ['s', 'Custom name']]
      ]);
    }

    try {
      const result = await new Promise((resolve, reject) => {
        this.bus.invoke({
          destination: 'com.victronenergy.settings',
          path: '/',
          'interface': 'com.victronenergy.Settings',
          member: 'AddSettings',
          signature: 'aa{sv}',
          body: [settingsArray]
        }, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      
      // Parse the actual assigned instance
      let actualInstance = deviceInstance;
      if (result && result.length > 0) {
        for (const item of result) {
          if (item && Array.isArray(item)) {
            const pathEntry = item.find(entry => entry && entry[0] === 'path');
            const valueEntry = item.find(entry => entry && entry[0] === 'value');
            
            if (pathEntry && valueEntry && 
                pathEntry[1] && pathEntry[1][1] && pathEntry[1][1][0] && 
                pathEntry[1][1][0].includes('ClassAndVrmInstance') &&
                valueEntry[1] && valueEntry[1][1] && valueEntry[1][1][0]) {
              
              const assignedValue = valueEntry[1][1][0];
              const instanceMatch = assignedValue.match(/:(\d+)$/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
              }
            }
          }
        }
      }
      
      // Update DeviceInstance property
      this.setValue('/DeviceInstance', actualInstance);
      
      this.emit('settingsRegistered', actualInstance);
      return actualInstance;
      
    } catch (err) {
      console.error(`Failed to register ${this.serviceName} in settings:`, err.message);
      throw err;
    }
  }

  /**
   * Disconnect the service
   */
  async disconnect() {
    if (this.bus && this.ownBus) {
      try {
        this.bus.end();
      } catch (err) {
        // Ignore disconnect errors
      }
    }
    
    this.bus = null;
    this.items.clear();
    this.exportedInterfaces.clear();
    this.emit('disconnected');
  }

  // Private methods

  async _requestServiceName() {
    return new Promise((resolve, reject) => {
      this.bus.requestName(this.serviceName, 0, (err, result) => {
        if (err) reject(new Error(`Failed to request service name ${this.serviceName}: ${err.message}`));
        else resolve(result);
      });
    });
  }

  _exportMgmtProperties() {
    Object.entries(this.mgmtProps).forEach(([path, prop]) => {
      this.items.set(path, {
        value: prop.value,
        type: this._getDbusType(prop.value),
        writable: prop.writable,
        text: this._pathToText(path)
      });
      this._exportProperty(path, this.items.get(path));
    });
  }

  _exportDeviceProperties() {
    Object.entries(this.deviceProps).forEach(([path, prop]) => {
      this.items.set(path, {
        value: prop.value,
        type: this._getDbusType(prop.value),
        writable: prop.writable,
        text: this._pathToText(path)
      });
      this._exportProperty(path, this.items.get(path));
    });
  }

  _exportRootInterface() {
    // Skip export for mock buses (for testing)
    if (!this.bus.exportInterface || typeof this.bus.exportInterface !== 'function') {
      return;
    }

    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetItems: ["", "a{sa{sv}}", [], ["items"]],
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", ["value"], ["result"]],
        GetText: ["", "s", [], ["text"]],
      },
      signals: {
        ItemsChanged: ["a{sa{sv}}", ["changes"]],
        PropertiesChanged: ["a{sv}", ["changes"]]
      }
    };

    const rootInterface = {
      GetItems: () => {
        const items = [];
        for (const [path, property] of this.items) {
          items.push([path, {
            Value: this._wrapValue(property.type, property.value),
            Text: this._wrapValue('s', property.text)
          }]);
        }
        return items;
      },
      
      GetValue: () => {
        return this._wrapValue('s', `SignalK Virtual Service: ${this.serviceName}`);
      },
      
      SetValue: (value) => {
        return -1; // Root object doesn't support setting values
      },
      
      GetText: () => {
        return `SignalK Virtual Service: ${this.serviceName}`;
      }
    };

    this.bus.exportInterface(rootInterface, "/", busItemInterface);
  }

  _exportProperty(path, property) {
    const interfaceKey = `${this.serviceName}${path}`;
    
    if (this.exportedInterfaces.has(interfaceKey)) {
      return; // Already exported
    }
    
    this.exportedInterfaces.add(interfaceKey);

    // Skip export for mock buses (for testing)
    if (!this.bus.exportInterface || typeof this.bus.exportInterface !== 'function') {
      return;
    }

    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", ["value"], ["result"]],
        GetText: ["", "s", [], ["text"]],
      },
      signals: {
        PropertiesChanged: ["a{sv}", ["changes"]]
      }
    };

    const propertyInterface = {
      GetValue: () => {
        const currentProperty = this.items.get(path);
        return this._wrapValue(currentProperty.type, currentProperty.value);
      },
      
      SetValue: (val) => {
        const currentProperty = this.items.get(path);
        if (!currentProperty.writable) {
          return -1; // Read-only property
        }
        
        const actualValue = Array.isArray(val) ? val[1] : val;
        
        // Validate range if specified
        if (currentProperty.min !== undefined && actualValue < currentProperty.min) {
          return -1; // Value too low
        }
        if (currentProperty.max !== undefined && actualValue > currentProperty.max) {
          return -1; // Value too high
        }
        
        this.setValue(path, actualValue);
        return 0; // Success
      },
      
      GetText: () => {
        const currentProperty = this.items.get(path);
        return currentProperty.text;
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  _wrapValue(type, value) {
    if (value === null || value === undefined) {
      return ["ai", []]; // Null as empty integer array per Victron standard
    }
    return [type, value];
  }

  _getDbusType(value) {
    if (value === null || value === undefined) return "d";
    if (typeof value === "string") return "s";
    if (typeof value === "boolean") return "b";
    if (typeof value === "number") {
      return Number.isInteger(value) ? "i" : "d";
    }
    return "v"; // variant for unknown types
  }

  _pathToText(path) {
    // Convert path to human-readable text
    const parts = path.split('/').filter(p => p);
    if (parts.length === 0) return 'Root';
    
    const last = parts[parts.length - 1];
    return last.replace(/([A-Z])/g, ' $1').trim();
  }
}

/**
 * SignalkTankService - Tank-specific D-Bus service
 */
export class SignalkTankService extends VeDbusService {
  constructor(tankInstance, bus = null) {
    const serviceName = `com.victronenergy.tank.signalk_${tankInstance.index}`;
    super(serviceName, bus);
    
    this.tankInstance = tankInstance;
    
    // Override device properties for tanks
    this.deviceProps['/ProductName'] = { value: `SignalK Tank: ${tankInstance.name}`, writable: false };
    this.deviceProps['/DeviceInstance'] = { value: tankInstance.index, writable: false };
    this.deviceProps['/CustomName'] = { value: tankInstance.name, writable: false };
  }

  async init(venusHost, port) {
    await super.init(venusHost, port);
    
    // Add tank-specific properties
    this.addProperty('/FluidType', this._getFluidType(), { text: 'Fluid type' });
    this.addProperty('/Level', 0, { text: 'Tank level (%)', min: 0, max: 100 });
    this.addProperty('/Capacity', 0, { text: 'Tank capacity (L)' });
    this.addProperty('/Remaining', 0, { text: 'Remaining volume (L)' });
    this.addProperty('/Status', 0, { text: 'Tank status' });
    
    return this;
  }

  updateLevel(levelPercent) {
    this.setValue('/Level', levelPercent);
    
    // Update remaining volume if capacity is known
    const capacity = this.getValue('/Capacity');
    if (capacity > 0) {
      this.setValue('/Remaining', (capacity * levelPercent / 100));
    }
    
    return this;
  }

  updateCapacity(capacityLiters) {
    this.setValue('/Capacity', capacityLiters);
    
    // Update remaining volume
    const level = this.getValue('/Level');
    this.setValue('/Remaining', (capacityLiters * level / 100));
    
    return this;
  }

  updateName(name) {
    this.setValue('/CustomName', name);
    this.tankInstance.name = name;
    return this;
  }

  _getFluidType() {
    const basePath = this.tankInstance.basePath;
    if (basePath.includes('fuel')) return 1; // Fuel
    if (basePath.includes('freshWater')) return 2; // Fresh water
    if (basePath.includes('wasteWater')) return 3; // Waste water
    if (basePath.includes('blackWater')) return 4; // Black water
    if (basePath.includes('oil')) return 5; // Oil
    return 0; // Unknown
  }
}

/**
 * SignalkBatteryService - Battery-specific D-Bus service
 */
export class SignalkBatteryService extends VeDbusService {
  constructor(batteryInstance, bus = null) {
    const serviceName = `com.victronenergy.battery.signalk_${batteryInstance.index}`;
    super(serviceName, bus);
    
    this.batteryInstance = batteryInstance;
    
    // Override device properties for batteries
    this.deviceProps['/ProductName'] = { value: `SignalK Battery: ${batteryInstance.name}`, writable: false };
    this.deviceProps['/DeviceInstance'] = { value: batteryInstance.index, writable: false };
    this.deviceProps['/CustomName'] = { value: batteryInstance.name, writable: false };
  }

  async init(venusHost, port) {
    await super.init(venusHost, port);
    
    // Add battery-specific properties
    this.addProperty('/Dc/0/Voltage', 0, { text: 'Battery voltage (V)' });
    this.addProperty('/Dc/0/Current', 0, { text: 'Battery current (A)' });
    this.addProperty('/Dc/0/Power', 0, { text: 'Battery power (W)' });
    this.addProperty('/Soc', 0, { text: 'State of charge (%)', min: 0, max: 100 });
    this.addProperty('/TimeToGo', 0, { text: 'Time to go (s)' });
    this.addProperty('/ConsumedAmphours', 0, { text: 'Consumed Ah' });
    
    return this;
  }

  updateVoltage(voltage) {
    this.setValue('/Dc/0/Voltage', voltage);
    this._updatePower();
    return this;
  }

  updateCurrent(current) {
    this.setValue('/Dc/0/Current', current);
    this._updatePower();
    return this;
  }

  updateSoc(socPercent) {
    this.setValue('/Soc', socPercent);
    return this;
  }

  _updatePower() {
    const voltage = this.getValue('/Dc/0/Voltage');
    const current = this.getValue('/Dc/0/Current');
    this.setValue('/Dc/0/Power', voltage * current);
  }
}
