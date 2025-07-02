import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.buses = {}; // Multiple buses for different sensor types
    this.envData = {};
    this.lastInitAttempt = 0;
    this.sensorInstances = {
      temperature: 24,
      humidity: 25
    };
  }

  async init() {
    // This method will be called for each sensor type as needed
    // We don't initialize all buses upfront, only when needed
  }

  async _initSensorBus(sensorType) {
    if (this.buses[sensorType]) {
      return this.buses[sensorType]; // Already initialized
    }

    try {
      // Create D-Bus connection using dbus-native with anonymous authentication
      const bus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Use appropriate service name for sensor type
      let serviceName;
      let deviceInstance;
      
      if (sensorType === 'temperature') {
        serviceName = `com.victronenergy.temperature.tty${this.sensorInstances.temperature}`;
        deviceInstance = this.sensorInstances.temperature;
      } else if (sensorType === 'humidity') {
        // Venus OS doesn't have a specific humidity service, use temperature service with different instance
        serviceName = `com.victronenergy.temperature.tty${this.sensorInstances.humidity}`;
        deviceInstance = this.sensorInstances.humidity;
      } else {
        throw new Error(`Unsupported sensor type: ${sensorType}`);
      }
      
      // Request service name
      await new Promise((resolve, reject) => {
        bus.requestName(serviceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      this.buses[sensorType] = bus;
      this._exportMgmt(bus, sensorType, deviceInstance);
      
      return bus;
      
    } catch (err) {
      // Convert errors to more user-friendly messages
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to Venus OS at ${this.settings.venusHost}:78 - ${err.code}`);
      } else if (err.message && err.message.includes('timeout')) {
        throw new Error(`Connection timeout to Venus OS at ${this.settings.venusHost}:78`);
      }
      throw new Error(err.message || err.toString());
    }
  }

  _exportMgmt(bus, sensorType, deviceInstance) {
    // Define the BusItem interface descriptor for dbus-native
    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", [], []],
        GetText: ["", "s", [], ["text"]],
      },
    };

    // Export management properties using dbus-native with proper interface descriptors
    const mgmtInterface = {
      GetValue: () => {
        return ['i', 1]; // Connected = 1 (integer, not double)
      },
      SetValue: (val) => {
        return 0; // Success
      },
      GetText: () => {
        return 'Connected'; // Native string return as you discovered
      }
    };

    bus.exportInterface(mgmtInterface, '/Mgmt/Connection', busItemInterface);

    // Product Name - Required for Venus OS recognition
    const productNameInterface = {
      GetValue: () => {
        return ['s', `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Sensor`];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);

    // Device Instance - Required for unique identification
    const deviceInstanceInterface = {
      GetValue: () => {
        return ['u', deviceInstance]; // Unsigned integer for device instance
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);

    // Custom Name
    const customNameInterface = {
      GetValue: () => {
        return ['s', `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Custom name';
      }
    };

    bus.exportInterface(customNameInterface, '/CustomName', busItemInterface);

    // Process Name and Version - Required for VRM registration
    const processNameInterface = {
      GetValue: () => {
        return ['s', `signalk-${sensorType}-sensor`];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);

    const processVersionInterface = {
      GetValue: () => {
        return ['s', '1.0.12'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process version';
      }
    };

    bus.exportInterface(processVersionInterface, '/Mgmt/ProcessVersion', busItemInterface);
  }

  _exportProperty(bus, path, config) {
    // Define the BusItem interface descriptor for dbus-native
    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", [], []],
        GetText: ["", "s", [], ["text"]],
      },
    };

    // Store initial value
    this.envData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.envData[path] || (config.type === 's' ? '' : 0)];
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.envData[path] = actualValue;
        this.emit('valueChanged', path, actualValue);
        return 0; // Success
      },
      GetText: () => {
        return config.text; // Native string return
      }
    };

    bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  _updateValue(path, value) {
    if (this.envData.hasOwnProperty(path)) {
      this.envData[path] = value;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid environment values silently
        return;
      }
      
      let sensorType;
      let bus;
      
      if (path.includes('temperature')) {
        sensorType = 'temperature';
        // Initialize temperature sensor bus if needed
        if (!this.buses.temperature) {
          // Only try to initialize once every 30 seconds to avoid spam
          const now = Date.now();
          if (!this.lastInitAttempt || (now - this.lastInitAttempt) > 30000) {
            this.lastInitAttempt = now;
            await this._initSensorBus('temperature');
          } else {
            // Skip silently if we recently failed to connect
            return;
          }
        }
        bus = this.buses.temperature;
        
        // Temperature in Celsius (Signal K spec uses Kelvin, convert to Celsius for Venus OS)
        let tempC = value;
        if (value > 200) {
          // Assume Kelvin, convert to Celsius
          tempC = value - 273.15;
        }
        this._exportProperty(bus, '/Temperature', { 
          value: tempC, 
          type: 'd', 
          text: 'Temperature' 
        });
        
        // Export status (0 = OK)
        this._exportProperty(bus, '/Status', { 
          value: 0, 
          type: 'i', 
          text: 'OK' 
        });
        
        this.emit('dataUpdated', 'Temperature', `${tempC.toFixed(1)}°C`);
      }
      else if (path.includes('humidity') || path.includes('relativeHumidity')) {
        sensorType = 'humidity';
        // Initialize humidity sensor bus if needed
        if (!this.buses.humidity) {
          // Only try to initialize once every 30 seconds to avoid spam
          const now = Date.now();
          if (!this.lastInitAttempt || (now - this.lastInitAttempt) > 30000) {
            this.lastInitAttempt = now;
            await this._initSensorBus('humidity');
          } else {
            // Skip silently if we recently failed to connect
            return;
          }
        }
        bus = this.buses.humidity;
        
        // Humidity as percentage (0-1 to 0-100)
        const humidityPercent = value > 1 ? value : value * 100;
        this._exportProperty(bus, '/Temperature', { 
          value: humidityPercent, 
          type: 'd', 
          text: 'Humidity' 
        });
        
        // Export status (0 = OK)
        this._exportProperty(bus, '/Status', { 
          value: 0, 
          type: 'i', 
          text: 'OK' 
        });
        
        this.emit('dataUpdated', 'Humidity', `${humidityPercent.toFixed(1)}%`);
      }
      else if (path.includes('pressure')) {
        // Pressure sensors would need their own implementation
        // For now, silently ignore pressure sensors
        return;
      }
      else {
        // Silently ignore unknown environment paths (no logging to avoid spam)
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
    // Disconnect all buses
    Object.keys(this.buses).forEach(sensorType => {
      const bus = this.buses[sensorType];
      if (bus) {
        try {
          bus.end();
        } catch (err) {
          // Ignore disconnect errors
        }
      }
    });
    
    this.buses = {};
    this.envData = {};
  }
}