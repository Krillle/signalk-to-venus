import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.sensorServices = new Map(); // Map of sensor paths to EnvironmentService instances
    this.nextInstance = 24; // Start from instance 24 for environment sensors
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
      case "u": return ["u", value];
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
    // Individual sensor services are created when needed
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid environment values silently
        return;
      }
      
      // Determine sensor type and process value
      let sensorType, processedValue, displayName;
      
      if (path.includes('temperature')) {
        sensorType = 'temperature';
        // Temperature in Celsius (Signal K spec uses Kelvin, convert to Celsius for Venus OS)
        processedValue = value > 200 ? value - 273.15 : value;
        
        // Extract sensor location from path (e.g., environment.water.temperature -> Water)
        const tempMatch = path.match(/environment\.([^.]+)\.temperature|propulsion\.([^.]+)\.temperature/);
        if (tempMatch) {
          const location = tempMatch[1] || tempMatch[2];
          displayName = `${location.charAt(0).toUpperCase() + location.slice(1)} Temperature`;
        } else {
          displayName = 'Temperature Sensor';
        }
      }
      else if (path.includes('humidity') || path.includes('relativeHumidity')) {
        sensorType = 'humidity';
        // Humidity as percentage (0-1 to 0-100)
        processedValue = value > 1 ? value : value * 100;
        
        // Extract sensor location from path
        const humMatch = path.match(/environment\.([^.]+)\.(humidity|relativeHumidity)/);
        if (humMatch) {
          const location = humMatch[1];
          displayName = `${location.charAt(0).toUpperCase() + location.slice(1)} Humidity`;
        } else {
          displayName = 'Humidity Sensor';
        }
      }
      else {
        // Silently ignore unknown environment paths (no logging to avoid spam)
        return;
      }
      
      // Get or create sensor service for this specific sensor path
      if (!this.sensorServices.has(path)) {
        const instance = this.nextInstance++;
        const service = new EnvironmentService(
          this.settings,
          path,
          sensorType,
          instance,
          displayName
        );
        
        await service.init();
        this.sensorServices.set(path, service);
      }
      
      // Update the sensor value
      const service = this.sensorServices.get(path);
      await service.updateValue(processedValue);
      
      this.emit('dataUpdated', displayName, 
        sensorType === 'temperature' ? `${processedValue.toFixed(1)}°C` : `${processedValue.toFixed(1)}%`);
        
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
    // Disconnect all sensor services
    for (const [path, service] of this.sensorServices) {
      try {
        await service.disconnect();
      } catch (err) {
        // Ignore disconnect errors
      }
    }
    
    this.sensorServices.clear();
  }
}

// Individual Environment Service class for each sensor instance
class EnvironmentService {
  constructor(settings, sensorPath, sensorType, instance, displayName) {
    this.settings = settings;
    this.sensorPath = sensorPath;
    this.sensorType = sensorType;
    this.instance = instance;
    this.displayName = displayName;
    this.bus = null;
    this.serviceName = `com.victronenergy.temperature.tty${instance}`;
    this.currentValue = null;
    this.exportedInterfaces = new Set();
  }

  async init() {
    try {
      // Create D-Bus connection
      this.bus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Request service name
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.serviceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Add serviceName property for interface tracking
      this.bus.serviceName = this.serviceName;

      // Export D-Bus interfaces
      this._exportDbusInterfaces();
      
      // Register in Venus OS Settings
      await this._registerInSettings();
      
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

  _exportDbusInterfaces() {
    // Define the BusItem interface descriptor matching vedbus.py
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

    // Management properties
    const mgmtProperties = {
      "/Mgmt/ProcessName": { type: "s", value: `signalk-${this.sensorType}-sensor`, text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" }
    };

    // Device properties
    const deviceProperties = {
      "/ProductName": { type: "s", value: `SignalK ${this.sensorType.charAt(0).toUpperCase() + this.sensorType.slice(1)} Sensor`, text: "Product name" },
      "/DeviceInstance": { type: "u", value: this.instance, text: "Device instance" },
      "/CustomName": { type: "s", value: this.displayName, text: "Custom name" },
      "/Temperature": { type: "d", value: this.currentValue || 0, text: this.sensorType === 'temperature' ? 'Temperature' : 'Humidity' },
      "/Status": { type: "i", value: 0, text: "Status" }
    };

    // Combine all properties
    const allProperties = { ...mgmtProperties, ...deviceProperties };

    // Export individual property interfaces
    Object.entries(allProperties).forEach(([path, config]) => {
      const propertyInterface = {
        GetValue: () => {
          if (path === '/Temperature') {
            return this.wrapValue(config.type, this.currentValue || 0);
          }
          return this.wrapValue(config.type, config.value);
        },
        SetValue: (val) => {
          if (path === '/Temperature') {
            const actualValue = Array.isArray(val) ? val[1] : val;
            this.currentValue = actualValue;
            return 0; // Success
          }
          return 0; // Success for other properties
        },
        GetText: () => config.text
      };

      const interfaceKey = `${this.serviceName}${path}`;
      if (!this.exportedInterfaces.has(interfaceKey)) {
        this.bus.exportInterface(propertyInterface, path, busItemInterface);
        this.exportedInterfaces.add(interfaceKey);
      }
    });

    // Root interface with GetItems
    const rootInterface = {
      GetItems: () => {
        const items = [];
        Object.entries(allProperties).forEach(([path, config]) => {
          let value = config.value;
          if (path === '/Temperature') {
            value = this.currentValue || 0;
          }
          
          items.push([path, {
            Value: this.wrapValue(config.type, value),
            Text: this.wrapValue("s", config.text)
          }]);
        });
        return items;
      },
      
      GetValue: () => {
        return this.wrapValue('s', `SignalK Virtual ${this.sensorType.charAt(0).toUpperCase() + this.sensorType.slice(1)} Service`);
      },
      
      SetValue: (value) => {
        return -1; // Error - root doesn't support setting values
      },
      
      GetText: () => {
        return `SignalK Virtual ${this.sensorType.charAt(0).toUpperCase() + this.sensorType.slice(1)} Service`;
      }
    };

    this.bus.exportInterface(rootInterface, "/", busItemInterface);
  }

  async updateValue(value) {
    this.currentValue = value;
    // Value updates are handled by the D-Bus interface GetValue methods
  }

  async _registerInSettings() {
    try {
      // Create a unique service name for this sensor
      const serviceName = `signalk_${this.sensorType}_${this.instance}`;
      
      // Proposed class and VRM instance
      const proposedInstance = `environment:${this.instance}`;

      // Create settings array following Victron's Settings API format
      const settingsArray = [
        [
          ['path', ['s', `/Settings/Devices/${serviceName}/ClassAndVrmInstance`]],
          ['default', ['s', proposedInstance]],
          ['type', ['s', 's']],
          ['description', ['s', 'Class and VRM instance']]
        ],
        [
          ['path', ['s', `/Settings/Devices/${serviceName}/CustomName`]],
          ['default', ['s', this.displayName]],
          ['type', ['s', 's']],
          ['description', ['s', 'Custom name']]
        ]
      ];

      // Call the Venus OS Settings API
      await new Promise((resolve, reject) => {
        this.bus.invoke({
          destination: 'com.victronenergy.settings',
          path: '/',
          'interface': 'com.victronenergy.Settings',
          member: 'AddSettings',
          signature: 'aa{sv}',
          body: [settingsArray]
        }, (err, result) => {
          if (err) {
            reject(new Error(`Settings registration failed: ${err.message || err}`));
          } else {
            resolve(result);
          }
        });
      });

      console.log(`${this.displayName} registered in Venus OS Settings: ${serviceName} -> ${proposedInstance}`);
      
    } catch (err) {
      console.error(`Failed to register ${this.displayName} in settings:`, err.message);
    }
  }

  async disconnect() {
    if (this.bus) {
      try {
        this.bus.end();
      } catch (err) {
        // Ignore disconnect errors
      }
    }
    this.bus = null;
    this.exportedInterfaces.clear();
  }

  // Legacy method for compatibility with existing tests
  _exportProperty(bus, path, config) {
    // This method is maintained for compatibility but the new architecture
    // exports all properties in _exportDbusInterfaces
    if (path === '/Temperature') {
      this.currentValue = config.value;
    }
  }
}