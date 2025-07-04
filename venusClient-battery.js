import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.batteryData = {};
    this.lastInitAttempt = 0;
    this.exportedInterfaces = new Set(); // Track which D-Bus interfaces have been exported
    this.settingsBus = null; // Separate bus for settings
    this.VBUS_SERVICE = `com.victronenergy.virtual.${deviceType}`;
    this.SETTINGS_SERVICE = 'com.victronenergy.settings';
    this.SETTINGS_ROOT = '/Settings/Devices';
    this.managementProperties = {};
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

  async init() {
    try {
      // Create D-Bus connection using dbus-native with anonymous authentication
      this.bus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Create separate settings bus connection
      this.settingsBus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Request service name for main bus
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.VBUS_SERVICE, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      this._exportMgmt();
      this._exportBatteryInterface();
      this._exportRootInterface(); // Export root interface for VRM compatibility
      
      // Register battery in Venus OS Settings for VRM visibility
      await this._registerBatteryInSettings(100);
      
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

  _exportMgmt() {
    // Define the BusItem interface descriptor for dbus-native with enhanced signatures
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

    // Export management properties using dbus-native with proper interface descriptors
    const mgmtInterface = {
      GetValue: () => {
        return this.wrapValue('i', 1); // Connected = 1 (integer)
      },
      SetValue: (val) => {
        return 0; // Success
      },
      GetText: () => {
        return 'Connected';
      }
    };

    this.bus.exportInterface(mgmtInterface, '/Mgmt/Connection', busItemInterface);
    this.managementProperties['/Mgmt/Connection'] = { value: 1, text: 'Connected' };

    // Product Name - Required for Venus OS recognition
    const productNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'SignalK Virtual Battery');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    this.bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);
    this.managementProperties['/ProductName'] = { value: 'SignalK Virtual Battery', text: 'Product name' };

    // Device Instance - Required for unique identification
    const deviceInstanceInterface = {
      GetValue: () => {
        return this.wrapValue('u', 100); // Unsigned integer for device instance
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    this.bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);
    this.managementProperties['/DeviceInstance'] = { value: 100, text: 'Device instance' };

    // Custom Name
    const customNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'SignalK Battery');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Custom name';
      }
    };

    this.bus.exportInterface(customNameInterface, '/CustomName', busItemInterface);
    this.managementProperties['/CustomName'] = { value: 'SignalK Battery', text: 'Custom name' };

    // Process Name and Version - Required for VRM registration
    const processNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'signalk-battery-sensor');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);
    this.managementProperties['/Mgmt/ProcessName'] = { value: 'signalk-battery-sensor', text: 'Process name' };

    const processVersionInterface = {
      GetValue: () => {
        return this.wrapValue('s', '1.0.12');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process version';
      }
    };

    this.bus.exportInterface(processVersionInterface, '/Mgmt/ProcessVersion', busItemInterface);
    this.managementProperties['/Mgmt/ProcessVersion'] = { value: '1.0.12', text: 'Process version' };
  }

  _exportBatteryInterface() {
    // Export battery-specific D-Bus interfaces using dbus-native
    const batteryPaths = {
      '/Dc/0/Voltage': { value: 0, type: 'd', text: 'Voltage' },
      '/Dc/0/Current': { value: 0, type: 'd', text: 'Current' },
      '/Soc': { value: 0, type: 'd', text: 'State of charge' },
      '/ConsumedAmphours': { value: 0, type: 'd', text: 'Consumed Amphours' },
      '/TimeToGo': { value: 0, type: 'd', text: 'Time to go' },
      '/Dc/0/Temperature': { value: 0, type: 'd', text: 'Temperature' },
      '/Relay/0/State': { value: 0, type: 'd', text: 'Relay state' }
    };

    // Export each battery property
    Object.entries(batteryPaths).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportProperty(path, config) {
    // Use a composite key to track both the D-Bus path and the interface
    const interfaceKey = `${path}`;
    
    // Only export if not already exported
    if (this.exportedInterfaces.has(interfaceKey)) {
      // Just update the value, don't re-export the interface
      this.batteryData[path] = config.value;
      return;
    }

    // Mark as exported
    this.exportedInterfaces.add(interfaceKey);

    // Define the BusItem interface descriptor for dbus-native with enhanced signatures
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
    this.batteryData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return this.wrapValue(config.type, this.batteryData[path] || 0);
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.batteryData[path] = actualValue;
        this.emit('valueChanged', path, actualValue);
        return 0; // Success
      },
      GetText: () => {
        return config.text;
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  _updateValue(path, value) {
    if (this.batteryData.hasOwnProperty(path)) {
      this.batteryData[path] = value;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (typeof value !== 'number' || value === null || value === undefined || isNaN(value)) {
        // Skip invalid battery values silently
        return;
      }
      
      if (!this.bus) {
        // Only try to initialize once every 30 seconds to avoid spam
        const now = Date.now();
        if (!this.lastInitAttempt || (now - this.lastInitAttempt) > 30000) {
          this.lastInitAttempt = now;
          await this.init();
        } else {
          // Skip silently if we recently failed to connect
          return;
        }
      }
      
      if (path.includes('voltage')) {
        this._updateValue('/Dc/0/Voltage', value);
        this.emit('dataUpdated', 'Battery Voltage', `${value.toFixed(2)}V`);
      }
      else if (path.includes('current')) {
        this._updateValue('/Dc/0/Current', value);
        this.emit('dataUpdated', 'Battery Current', `${value.toFixed(1)}A`);
      }
      else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
        this._updateValue('/Soc', value);
        this.emit('dataUpdated', 'State of Charge', `${Math.round(value * 100)}%`);
      }
      else if (path.includes('consumed') || (path.includes('capacity') && path.includes('consumed'))) {
        this._updateValue('/ConsumedAmphours', value);
        this.emit('dataUpdated', 'Consumed Ah', `${value.toFixed(1)}Ah`);
      }
      else if (path.includes('timeRemaining') || (path.includes('capacity') && path.includes('time'))) {
        if (value !== null) {
          this._updateValue('/TimeToGo', value);
          this.emit('dataUpdated', 'Time Remaining', `${Math.round(value/60)}min`);
        }
      }
      else if (path.includes('relay')) {
        this._updateValue('/Relay/0/State', value);
        this.emit('dataUpdated', 'Relay', value ? 'On' : 'Off');
      }
      else if (path.includes('temperature')) {
        this._updateValue('/Dc/0/Temperature', value);
        this.emit('dataUpdated', 'Battery Temp', `${value.toFixed(1)}°C`);
      }
      else if (path.includes('name')) {
        // Handle battery name/label - not updating D-Bus value, just for logging
        this.emit('dataUpdated', 'Battery Name', value);
      }
      else {
        // Silently ignore unknown battery paths instead of throwing errors
        // Silently ignore unknown battery paths
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  _exportRootInterface() {
    // Export a root interface for VRM compatibility - includes all management properties
    const rootInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetItems: ["", "a{sa{sv}}", [], ["items"]],
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["sv", "i", ["path", "value"], ["result"]],
        GetText: ["", "v", [], ["text"]],
      },
      signals: {
        ItemsChanged: ["a{sa{sv}}", ["changes"]],
        PropertiesChanged: ["a{sv}", ["changes"]]
      }
    };

    const rootInterfaceImpl = {
      GetItems: () => {
        // Return all management properties and battery data in the correct vedbus.py format
        // Format: a{sa{sv}} - array of dictionary entries with string keys and variant values
        const items = [];
        
        // Add management properties
        Object.entries(this.managementProperties).forEach(([path, info]) => {
          items.push([path, {
            Value: this.wrapValue(this.getType(info.value), info.value),
            Text: this.wrapValue('s', info.text)
          }]);
        });

        // Add battery data properties
        Object.entries(this.batteryData).forEach(([path, value]) => {
          const batteryPaths = {
            '/Dc/0/Voltage': 'Voltage',
            '/Dc/0/Current': 'Current',
            '/Soc': 'State of charge',
            '/ConsumedAmphours': 'Consumed Amphours',
            '/TimeToGo': 'Time to go',
            '/Dc/0/Temperature': 'Temperature',
            '/Relay/0/State': 'Relay state'
          };
          
          const text = batteryPaths[path] || 'Battery property';
          items.push([path, {
            Value: this.wrapValue('d', value),
            Text: this.wrapValue('s', text)
          }]);
        });

        return items;
      },
      
      GetValue: () => {
        // Return dictionary of relative paths and their values (vedbus.py line ~460)
        // This is for the root object, not individual path lookup
        const values = {};
        
        // Add management properties (as relative paths from root)
        Object.entries(this.managementProperties).forEach(([path, info]) => {
          const relativePath = path.startsWith('/') ? path.substring(1) : path;
          values[relativePath] = this.wrapValue(this.getType(info.value), info.value);
        });

        // Add battery data properties (as relative paths from root)
        Object.entries(this.batteryData).forEach(([path, value]) => {
          const relativePath = path.startsWith('/') ? path.substring(1) : path;
          values[relativePath] = this.wrapValue('d', value);
        });

        return values;
      },
      
      SetValue: (value) => {
        // Root object doesn't support setting values
        return -1; // Error
      },
      
      GetText: () => {
        // Return dictionary of relative paths and their text representations (vedbus.py)
        const texts = {};
        
        // Add management properties (as relative paths from root)
        Object.entries(this.managementProperties).forEach(([path, info]) => {
          const relativePath = path.startsWith('/') ? path.substring(1) : path;
          texts[relativePath] = info.text;
        });

        // Add battery data properties (as relative paths from root)
        Object.entries(this.batteryData).forEach(([path, value]) => {
          const relativePath = path.startsWith('/') ? path.substring(1) : path;
          const batteryPaths = {
            'Dc/0/Voltage': 'Voltage',
            'Dc/0/Current': 'Current',
            'Soc': 'State of charge',
            'ConsumedAmphours': 'Consumed Amphours',
            'TimeToGo': 'Time to go',
            'Dc/0/Temperature': 'Temperature',
            'Relay/0/State': 'Relay state'
          };
          texts[relativePath] = batteryPaths[relativePath] || 'Battery property';
        });

        return texts;
      }
    };

    this.bus.exportInterface(rootInterfaceImpl, '/', rootInterface);
  }

  async _registerBatteryInSettings(batteryInstance) {
    if (!this.settingsBus) {
      return batteryInstance || 100; // Fallback to default device instance
    }

    try {
      // Create a unique service name for this battery
      const serviceName = `signalk_battery_${this.VBUS_SERVICE.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Proposed class and VRM instance (battery type and instance)
      const proposedInstance = `battery:${batteryInstance || 100}`;
      
      // Create settings array following Victron's Settings API format
      const settingsArray = [
        {
          'path': [`Settings/Devices/${serviceName}/ClassAndVrmInstance`],
          'default': [proposedInstance],
          'type': ['s'], // string type
          'description': ['Class and VRM instance']
        },
        {
          'path': [`Settings/Devices/${serviceName}/CustomName`],
          'default': ['SignalK Battery'],
          'type': ['s'], // string type  
          'description': ['Custom name']
        }
      ];

      // Call the Venus OS Settings API to register the device
      // This is the critical missing piece - we need to call AddSettings
      await new Promise((resolve, reject) => {
        this.settingsBus.invoke(
          'com.victronenergy.settings',
          '/',
          'com.victronenergy.Settings',
          'AddSettings',
          'aa{sv}',
          [settingsArray],
          (err, result) => {
            if (err) {
              reject(new Error(`Settings registration failed: ${err.message || err}`));
            } else {
              resolve(result);
            }
          }
        );
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

      // Export ClassAndVrmInstance interface
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

      this.settingsBus.exportInterface(classInterface, `/Settings/Devices/${serviceName}/ClassAndVrmInstance`, busItemInterface);

      // Export CustomName interface
      const nameInterface = {
        GetValue: () => {
          return this.wrapValue('s', 'SignalK Battery');
        },
        SetValue: (val) => {
          return 0; // Success
        },
        GetText: () => {
          return 'Custom name';
        }
      };

      this.settingsBus.exportInterface(nameInterface, `/Settings/Devices/${serviceName}/CustomName`, busItemInterface);

      console.log(`Battery registered in Venus OS Settings: ${serviceName} -> ${proposedInstance}`);
      return batteryInstance || 100;
      
    } catch (err) {
      console.error('Failed to register battery in settings:', err.message);
      return batteryInstance || 100; // Fallback to default instance
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
    }
    
    if (this.settingsBus) {
      try {
        this.settingsBus.end();
      } catch (err) {
        // Ignore disconnect errors
      }
      this.settingsBus = null;
    }
    
    this.batteryData = {};
    this.exportedInterfaces.clear();
  }
}
