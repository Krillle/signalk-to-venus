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
    this.exportedInterfaces = new Set(); // Track which D-Bus interfaces have been exported
    this.sensorInstances = {
      temperature: 24,
      humidity: 25
    };
  }

  // Helper function to wrap values in D-Bus variant format  
  wrapValue(type, value) {
    if (value === null) {
      return ["ai", []]; // Null as empty integer array per Victron standard
    }
    switch (type) {
      case "b": return ["b", value];
      case "s": return ["s", value];
      case "i": return ["i", value];
      case "d": return ["d", value];
      default: return type.type ? this.wrapValue(type.type, value) : value;
    }
  }

  // Helper function to get D-Bus type for JavaScript values
  getType(value) {
    if (value === null) return "d";
    if (typeof value === "undefined") throw new Error("Value cannot be undefined");
    if (typeof value === "string") return "s";
    if (typeof value === "number") {
      if (isNaN(value)) throw new Error("NaN is not a valid input");
      return Number.isInteger(value) ? "i" : "d";
    }
    throw new Error("Unsupported type: " + typeof value);
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

      // Add serviceName property for interface tracking
      bus.serviceName = serviceName;

      this.buses[sensorType] = bus;
      this._exportMgmt(bus, sensorType, deviceInstance);
      
      // Register sensor in Venus OS Settings for VRM visibility
      await this._registerEnvironmentSensorInSettings(sensorType, deviceInstance);
      
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
    // Define the BusItem interface descriptor matching dbus-victron-virtual
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
        PropertiesChanged: ["a{sv}", ["changes"]],
      },
    };

    // Root interface with GetItems and GetValue for all properties
    const rootInterface = {
      GetItems: () => {
        // Return all management properties in the correct vedbus.py format
        // Format: a{sa{sv}} - array of dictionary entries with string keys and variant values
        const items = [];
        
        // Add management properties
        items.push(["/Mgmt/Connection", {
          Value: this.wrapValue("i", 1),
          Text: this.wrapValue("s", "Connected")
        }]);
        items.push(["/ProductName", {
          Value: this.wrapValue("s", `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Sensor`),
          Text: this.wrapValue("s", "Product name")
        }]);
        items.push(["/DeviceInstance", {
          Value: this.wrapValue("u", deviceInstance),
          Text: this.wrapValue("s", "Device instance")
        }]);
        items.push(["/CustomName", {
          Value: this.wrapValue("s", `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`),
          Text: this.wrapValue("s", "Custom name")
        }]);
        items.push(["/Mgmt/ProcessName", {
          Value: this.wrapValue("s", `signalk-${sensorType}-sensor`),
          Text: this.wrapValue("s", "Process name")
        }]);
        items.push(["/Mgmt/ProcessVersion", {
          Value: this.wrapValue("s", "1.0.12"),
          Text: this.wrapValue("s", "Process version")
        }]);
        
        // Add environment data properties
        Object.entries(this.envData).forEach(([path, value]) => {
          const envPaths = {
            '/Temperature': 'Temperature',
            '/Status': 'Status'
          };
          
          const text = envPaths[path] || 'Environment property';
          items.push([path, {
            Value: this.wrapValue('d', value),
            Text: this.wrapValue('s', text)
          }]);
        });

        return items;
      },
      
      GetValue: () => {
        // Root object value
        return this.wrapValue('s', `SignalK Virtual ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Service`);
      },
      
      SetValue: (value) => {
        // Root object doesn't support setting values
        return -1; // Error
      },
      
      GetText: () => {
        return `SignalK Virtual ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Service`;
      }
    };

    bus.exportInterface(rootInterface, "/", busItemInterface);

    // Individual property interfaces following dbus-victron-virtual pattern
    const properties = {
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" },
      "/ProductName": { type: "s", value: `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} Sensor`, text: "Product name" },
      "/DeviceInstance": { type: "u", value: deviceInstance, text: "Device instance" },
      "/CustomName": { type: "s", value: `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`, text: "Custom name" },
      "/Mgmt/ProcessName": { type: "s", value: `signalk-${sensorType}-sensor`, text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" }
    };

    // Export individual property interfaces
    Object.entries(properties).forEach(([path, config]) => {
      const propertyInterface = {
        GetValue: () => this.wrapValue(config.type, config.value),
        SetValue: (val) => 0, // Success
        GetText: () => config.text
      };

      bus.exportInterface(propertyInterface, path, {
        name: "com.victronenergy.BusItem",
        methods: {
          GetValue: ["", "v", [], ["value"]],
          SetValue: ["v", "i", ["value"], ["result"]],
          GetText: ["", "s", [], ["text"]],
        },
        signals: {
          PropertiesChanged: ["a{sv}", ["changes"]]
        }
      });
    });
  }

  _exportProperty(bus, path, config) {
    // Create a unique key for this specific bus service and path
    const serviceKey = bus.serviceName || 'unknown';
    const interfaceKey = `${serviceKey}${path}`;
    
    // Only export if not already exported
    if (this.exportedInterfaces.has(interfaceKey)) {
      // Just update the value, don't re-export the interface
      this.envData[path] = config.value;
      return;
    }

    // Mark as exported
    this.exportedInterfaces.add(interfaceKey);

    // Define the BusItem interface descriptor for dbus-native
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

    // Store initial value
    this.envData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        const currentValue = this.envData[path] || (config.type === 's' ? '' : 0);
        return this.wrapValue(config.type, currentValue);
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

  async _registerEnvironmentSensorInSettings(sensorType, deviceInstance) {
    // Environment sensors don't have separate settings bus, so we'll use the main bus
    const bus = this.buses[sensorType];
    if (!bus) {
      return deviceInstance; // Fallback to default instance
    }

    try {
      // Create a unique service name for this sensor
      const serviceName = `signalk_${sensorType}_${deviceInstance}`;
      
      // Proposed class and VRM instance (sensor type and instance)
      const proposedInstance = `${sensorType}:${deviceInstance}`;

      // Create settings array following Victron's Settings API format
      // Simplified format for dbus-native - no manual variant wrapping needed
      const settingsArray = [
        {
          'path': `/Settings/Devices/${serviceName}/ClassAndVrmInstance`,
          'default': proposedInstance,
          'type': 's', // string type
          'description': 'Class and VRM instance'
        },
        {
          'path': `/Settings/Devices/${serviceName}/CustomName`,
          'default': `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`,
          'type': 's', // string type  
          'description': 'Custom name'
        }
      ];

      // Call the Venus OS Settings API to register the device using the main bus
      await new Promise((resolve, reject) => {
        console.log('Invoking Settings API with:', JSON.stringify(settingsArray, null, 2));
        
        // Use the correct dbus-native invoke format with the main bus
        bus.invoke({
          destination: 'com.victronenergy.settings',
          path: '/',
          'interface': 'com.victronenergy.Settings',
          member: 'AddSettings',
          signature: 'aa{sv}',
          body: [settingsArray]
        }, (err, result) => {
          if (err) {
            console.log('Settings API error:', err);
            console.dir(err);
            reject(new Error(`Settings registration failed: ${err.message || err}`));
          } else {
            console.log('Settings API result:', result);
            resolve(result);
          }
        });
      });

      // Also export the D-Bus interfaces for direct access
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

      // Export ClassAndVrmInstance interface using the main bus
      const classInterface = {
        GetValue: () => {
          return this.wrapValue('s', proposedInstance);
        },
        SetValue: (val) => {
          return 0; // Success
        },
        GetText: () => {
          return 'Class and VRM instance';
        }
      };

      bus.exportInterface(classInterface, `/Settings/Devices/${serviceName}/ClassAndVrmInstance`, busItemInterface);

      // Export CustomName interface using the main bus
      const nameInterface = {
        GetValue: () => {
          return this.wrapValue('s', `SignalK ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`);
        },
        SetValue: (val) => {
          return 0; // Success
        },
        GetText: () => {
          return 'Custom name';
        }
      };

      bus.exportInterface(nameInterface, `/Settings/Devices/${serviceName}/CustomName`, busItemInterface);

      console.log(`${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)} sensor registered in Venus OS Settings: ${serviceName} -> ${proposedInstance}`);
      return deviceInstance;
      
    } catch (err) {
      console.error(`Failed to register ${sensorType} sensor in settings:`, err.message);
      return deviceInstance; // Fallback to default instance
    }
  }

  async disconnect() {
    // Disconnect all buses (including settings buses)
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
    this.exportedInterfaces.clear();
  }
}