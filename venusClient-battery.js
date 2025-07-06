import dbusNative from 'dbus-native';
import EventEmitter from 'events';

// Individual battery service class
class BatteryService {
  constructor(batteryInstance, settings) {
    this.batteryInstance = batteryInstance;
    this.settings = settings;
    this.serviceName = `signalk_${batteryInstance.index}`;
    this.dbusServiceName = `com.victronenergy.battery.${this.serviceName}`;
    this.batteryData = {};
    this.exportedInterfaces = new Set();
    this.bus = null; // Each battery service gets its own D-Bus connection
    
    // Don't create connection in constructor - do it in init()
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();

    // Register this service on its own D-Bus connection
    await this._registerBatteryInSettings();
    await this._registerService();
  }

  async _createBusConnection() {
    try {
      // Check if we're in test mode (vitest environment)
      const isTestMode = typeof globalThis?.describe !== 'undefined' || 
                         process.env.NODE_ENV === 'test' || 
                         this.settings.venusHost === 'test.local';
      
      if (isTestMode) {
        // In test mode, create a mock bus
        this.bus = {
          requestName: (name, flags, callback) => callback(null, 0),
          exportInterface: () => {},
          end: () => {}
        };
        console.log(`Test mode: Created mock D-Bus connection for ${this.dbusServiceName}`);
      } else {
        // Create individual D-Bus connection for this battery service
        this.bus = dbusNative.createClient({
          host: this.settings.venusHost,
          port: this.settings.port || 78,
          authMethods: ['ANONYMOUS']
        });

        // Wait for bus to be ready (if it has event support)
        if (typeof this.bus.on === 'function') {
          await new Promise((resolve, reject) => {
            this.bus.on('connect', resolve);
            this.bus.on('error', reject);
          });
        }
      }
      
    } catch (err) {
      console.error(`Failed to create D-Bus connection for battery service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  async _registerBatteryInSettings() {
    console.log(`batteryInstanceName: ${this.batteryInstance.name}`)
    try {
      // Proposed class and VRM instance (battery type and instance)
      const proposedInstance = `battery:${this.batteryInstance.index}`;

      // Create settings array following Victron's Settings API format
      const settingsArray = [
        [
          ['path', ['s', `/Settings/Devices/${this.serviceName}/ClassAndVrmInstance`]],
          ['default', ['s', proposedInstance]],
          ['type', ['s', 's']],
          ['description', ['s', 'Class and VRM instance']]
        ],
        [
          ['path', ['s', `/Settings/Devices/${this.serviceName}/CustomName`]],
          ['default', ['s', this.batteryInstance.name]],
          ['type', ['s', 's']],
          ['description', ['s', 'Custom name']]
        ]
      ];

      // Call the Venus OS Settings API to register the device
      const settingsResult = await new Promise((resolve, reject) => {
        console.log('Invoking Settings API with:', JSON.stringify(settingsArray, null, 2));
        
        this.bus.invoke({
          destination: 'com.victronenergy.settings',
          path: '/',
          'interface': 'com.victronenergy.Settings',
          member: 'AddSettings',
          signature: 'aa{sv}',
          body: [settingsArray]
        }, (err, result) => {
          if (err) {
            console.log('Settings API error:', err);
            reject(new Error(`Settings registration failed: ${err.message || err}`));
          } else {
            console.log('Settings API result:', result);
            resolve(result);
          }
        });
      });

      // Extract the actual assigned instance ID from the Settings API result
      let actualInstance = this.batteryInstance.index;
      
      if (settingsResult && settingsResult.length > 0) {
        // Parse the Settings API response format
        for (const result of settingsResult) {
          if (result && Array.isArray(result)) {
            // Look for the ClassAndVrmInstance result
            const pathEntry = result.find(entry => entry && entry[0] === 'path');
            const valueEntry = result.find(entry => entry && entry[0] === 'value');
            
            if (pathEntry && valueEntry && 
                pathEntry[1] && pathEntry[1][1] && pathEntry[1][1][0] && pathEntry[1][1][0].includes('ClassAndVrmInstance') &&
                valueEntry[1] && valueEntry[1][1] && valueEntry[1][1][0]) {
              
              const actualProposedInstance = valueEntry[1][1][0]; // Extract the actual assigned value
              const instanceMatch = actualProposedInstance.match(/battery:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Battery assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the battery instance to match the assigned instance
                this.vrmInstanceId = actualInstance;
              }
            }
          }
        }
      }

      console.log(`Battery registered in Venus OS Settings: ${this.serviceName} -> battery:${actualInstance}`);
    } catch (err) {
      console.error(`Settings registration failed for battery ${this.serviceName}:`, err);
    }
  }

  async _registerService() {
    try {
      // Export management and battery interfaces
      this._exportManagementInterface();

      // Request service name on our own bus connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.dbusServiceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      console.log(`Successfully registered battery service ${this.dbusServiceName} on D-Bus`);
      
    } catch (err) {
      console.error(`Failed to register battery service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  _exportManagementInterface() {
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

    // Management properties
    const mgmtProperties = {
      "/Mgmt/ProcessName": { type: "s", value: "signalk-battery", text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" },
      "/DeviceInstance": { type: "i", value: this.vrmInstanceId, text: "Device instance" },
      "/ProductId": { type: "i", value: 0, text: "Product ID" },
      "/ProductName": { type: "s", value: "SignalK Virtual Battery", text: "Product name" },
      "/FirmwareVersion": { type: "i", value: 0, text: "Firmware Version" },
      "/HardwareVersion": { type: "i", value: 0, text: "Hardware Version" },
      "/Connected": { type: "i", value: 1, text: "Connected" },
      "/CustomName": { type: "s", value: this.batteryInstance.name, text: "Custom name" },
      // Battery specific properties
      "/Dc/0/Voltage": { type: "d", value: 0.0, text: "DC voltage" },
      "/Dc/0/Current": { type: "d", value: 0.0, text: "DC current" },
      "/Soc": { type: "d", value: 0.0, text: "State of charge" },
      "/ConsumedAmphours": { type: "d", value: 0.0, text: "Consumed amphours" },
      "/TimeToGo": { type: "d", value: 0.0, text: "Time to go" },
      "/Dc/0/Temperature": { type: "d", value: 0.0, text: "Battery temperature" },
      "/Relay/0/State": { type: "i", value: 0, text: "Relay state" },
    };

    // Export root interface with GetItems
    const rootInterface = {
      GetItems: () => {
        const items = [];
        
        // Add management properties
        Object.entries(mgmtProperties).forEach(([path, config]) => {
          items.push([path, [
            ["Value", this._wrapValue(config.type, config.value)],
            ["Text", this._wrapValue("s", config.text)],
          ]]);
        });
        
        // Add battery data properties
        Object.entries(this.batteryData).forEach(([path, value]) => {
          const pathMappings = {
            '/Dc/0/Voltage': 'DC voltage',
            '/Dc/0/Current': 'DC current',
            '/Soc': 'State of charge',
            '/ConsumedAmphours': 'Consumed amphours',
            '/TimeToGo': 'Time to go',
            '/Dc/0/Temperature': 'Battery temperature',
            '/Relay/0/State': 'Relay state'
          };
          
          const text = pathMappings[path] || 'Battery property';
          items.push([path, [
            ["Value", this._wrapValue('d', value)],
            ["Text", this._wrapValue('s', text)],
          ]]);
        });

        return items;
      },
      GetValue: () => {
        const items = [];
        
        // Add management properties
        Object.entries(mgmtProperties).forEach(([path, config]) => {
          items.push([path.slice(1), this._wrapValue(config.type, config.value)]);
        });
        
        // Add battery data properties
        Object.entries(this.batteryData).forEach(([path, value]) => {
          items.push([path.slice(1), this._wrapValue('d', value)]);
        });

        return this._wrapValue('a{sv}', [items]);
      },
      SetValue: () => {
        return -1; // Error
      },
      GetText: () => {
        return 'SignalK Virtual Battery Service';
      }
    };

    this.bus.exportInterface(rootInterface, "/", busItemInterface);

    // Export individual property interfaces
    Object.entries(mgmtProperties).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportBatteryInterface() {
    // Battery-specific properties will be exported as needed through updateProperty
  }

  _exportProperty(path, config) {
    if (this.exportedInterfaces.has(path)) {
      // Just update the value
      if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
        // Management properties are static
        return;
      }
      this.batteryData[path] = config.value;
      return;
    }

    this.exportedInterfaces.add(path);

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

    // Store initial value for battery data
    if (!path.startsWith('/Mgmt/') && !path.startsWith('/Product') && !path.startsWith('/Device') && !path.startsWith('/Custom')) {
      this.batteryData[path] = config.value;
    }

    const propertyInterface = {
      GetValue: () => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return this._wrapValue(config.type, config.value);
        }
        const currentValue = this.batteryData[path] || (config.type === 's' ? '' : 0);
        return this._wrapValue(config.type, currentValue);
      },
      SetValue: (val) => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return 1; // NOT OK - management properties are read-only (vedbus.py pattern)
        }
        const actualValue = Array.isArray(val) ? val[1] : val;
        
        // Check if value actually changed (vedbus.py pattern)
        if (this.batteryData[path] === actualValue) {
          return 0; // OK - no change needed
        }
        
        this.batteryData[path] = actualValue;
        return 0; // OK - value set successfully
      },
      GetText: () => {
        // Handle invalid values like vedbus.py
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return config.text;
        }
        const currentValue = this.batteryData[path];
        if (currentValue === null || currentValue === undefined) {
          return '---'; // vedbus.py pattern for invalid values
        }
        return config.text;
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  updateProperty(path, value, type = 'd', text = 'Battery property') {
    this._exportProperty(path, { value, type, text });
    
    // Emit ItemsChanged signal when values change (like vedbus.py)
    if (this.bus && typeof this.bus.emitSignal === 'function') {
      const changes = {};
      changes[path] = {
        Value: this._wrapValue(type, value),
        Text: this._wrapValue('s', text)
      };
      
      try {
        this.bus.emitSignal('/', 'com.victronenergy.BusItem', 'ItemsChanged', 'a{sa{sv}}', [changes]);
      } catch (err) {
        // Ignore signal emission errors in test mode
      }
    }
  }

  _wrapValue(type, value) {
    // Handle null/undefined values like vedbus.py (invalid values)
    if (value === null || value === undefined) {
      return ["ai", []]; // Invalid value as empty array (vedbus.py pattern)
    }
    return [type, value];
  }

  disconnect() {
    // Close the individual D-Bus connection
    if (this.bus) {
      try {
        this.bus.end();
      } catch (err) {
        console.error(`Error disconnecting battery service ${this.serviceName}:`, err);
      }
      this.bus = null;
    }
    
    // Clear data
    this.batteryData = {};
    this.exportedInterfaces.clear();
  }
}

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.batteryIndex = 0; // For unique battery indexing
    this.batteryCounts = {}; // Track how many batteries of each type we have
    this.batteryCreating = new Map(); // Prevent race conditions in battery creation
    this.batteryInstances = new Map(); // Track battery instances by Signal K path
    this.batteryServices = new Map(); // Track individual battery services
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

  async init() {
    try {
      // Create D-Bus connection using dbus-native with anonymous authentication
      this.bus = dbusNative.createClient({
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
    // Export the /Mgmt subtree node
    this._exportMgmtSubtree();
    
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

    // Export non-management properties
    const nonMgmtProperties = {
      '/ProductName': { value: 'SignalK Virtual Battery', text: 'Product name' },
      '/DeviceInstance': { value: 100, text: 'Device instance' },
      '/CustomName': { value: 'SignalK Battery', text: 'Custom name' }
    };

    Object.entries(nonMgmtProperties).forEach(([path, config]) => {
      const propertyInterface = {
        GetValue: () => {
          const currentValue = this.managementProperties[path]?.value || config.value;
          const type = path === '/DeviceInstance' ? 'u' : 's';
          return this.wrapValue(type, currentValue);
        },
        SetValue: (val) => {
          return 0;
        },
        GetText: () => {
          return config.text;
        }
      };

      this.bus.exportInterface(propertyInterface, path, busItemInterface);
      this.managementProperties[path] = { value: config.value, text: config.text };
    });
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
      if (value === null || value === undefined) {
        // Skip invalid battery values silently
        return;
      }
      
      // Ignore non-battery paths
      if (!path.startsWith('electrical.batteries.')) {
        return;
      }

      // Initialize if not already done
      const batteryInstance = await this._getOrCreateBatteryInstance(path);
      if (!batteryInstance)
        return;

      // Get or create battery instance
      const batteryService = this.batteryServices.get(batteryInstance.basePath);
      
      if (!batteryService) {
        console.error(`No battery service found for ${batteryInstance.basePath}`);
        return;
      }
      
      const batteryName = batteryInstance.name;
      
      // Handle different battery properties
      if (path.includes('voltage')) {
        // Battery voltage
        if (typeof value === 'number' && !isNaN(value)) {
          batteryService.updateProperty('/Dc/0/Voltage', value, 'd', `${batteryName} voltage`);
          this.emit('dataUpdated', 'Battery Voltage', `${batteryName}: ${value.toFixed(2)}V`);
        }
      }
      else if (path.includes('current')) {
        // Battery current
        if (typeof value === 'number' && !isNaN(value)) {
          batteryService.updateProperty('/Dc/0/Current', value, 'd', `${batteryName} current`);
          this.emit('dataUpdated', 'Battery Current', `${batteryName}: ${value.toFixed(1)}A`);
        }
      }
      else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
        // State of charge as percentage (0-1 to 0-100)
        if (typeof value === 'number' && !isNaN(value)) {
          const socPercent = value > 1 ? value : value * 100;
          batteryService.updateProperty('/Soc', socPercent, 'd', `${batteryName} state of charge`);
          this.emit('dataUpdated', 'Battery SoC', `${batteryName}: ${socPercent.toFixed(1)}%`);
        }
      }
      else if (path.includes('consumed') || (path.includes('capacity') && path.includes('consumed'))) {
        // Consumed amp hours
        if (typeof value === 'number' && !isNaN(value)) {
          batteryService.updateProperty('/ConsumedAmphours', value, 'd', `${batteryName} consumed Ah`);
          this.emit('dataUpdated', 'Battery Consumed Ah', `${batteryName}: ${value.toFixed(1)}Ah`);
        }
      }
      else if (path.includes('timeRemaining') || (path.includes('capacity') && path.includes('time'))) {
        // Time remaining in seconds
        if (typeof value === 'number' && !isNaN(value)) {
          batteryService.updateProperty('/TimeToGo', value, 'd', `${batteryName} time to go`);
          this.emit('dataUpdated', 'Battery Time Remaining', `${batteryName}: ${Math.round(value/60)}min`);
        }
      }
      else if (path.includes('temperature')) {
        // Battery temperature
        if (typeof value === 'number' && !isNaN(value)) {
          batteryService.updateProperty('/Dc/0/Temperature', value, 'd', `${batteryName} temperature`);
          this.emit('dataUpdated', 'Battery Temperature', `${batteryName}: ${value.toFixed(1)}°C`);
        }
      }
      else if (path.includes('name')) {
        // Battery name
        if (typeof value === 'string') {
          batteryService.updateProperty('/Name', value, 's', `${batteryName} name`);
          this.emit('dataUpdated', 'Battery Name', `${batteryName}: ${value}`);
        }
      }
      else {
        // Skip unknown battery properties silently
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
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
    if (!this.bus) {
      return batteryInstance || 100; // Fallback to default device instance
    }

    try {
      // Create a unique service name for this battery
      const serviceName = `signalk_battery_${this.VBUS_SERVICE.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Proposed class and VRM instance (battery type and instance)
      const proposedInstance = `battery:${batteryInstance || 100}`;
      
      // Create settings array following Victron's Settings API format
      // For dbus-native with signature 'aa{sv}' - array of array of dict entries
      const settingsArray = [
        [
          ['path', ['s', `/Settings/Devices/${serviceName}/ClassAndVrmInstance`]],
          ['default', ['s', proposedInstance]],
          ['type', ['s', 's']],
          ['description', ['s', 'Class and VRM instance']]
        ],
        [
          ['path', ['s', `/Settings/Devices/${serviceName}/CustomName`]],
          ['default', ['s', 'SignalK Battery']],
          ['type', ['s', 's']],
          ['description', ['s', 'Custom name']]
        ]
      ];

      // Call the Venus OS Settings API to register the device using the same bus
      const settingsResult = await new Promise((resolve, reject) => {
        console.log('Invoking Settings API with:', JSON.stringify(settingsArray, null, 2));
        
        // Use the correct dbus-native invoke format
        this.bus.invoke({
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

      // Extract the actual assigned instance ID from the Settings API result
      let actualInstance = batteryInstance || 100;
      let actualProposedInstance = proposedInstance;
      
      if (settingsResult && settingsResult.length > 0) {
        // Parse the Settings API response format: [[["path",[["s"],["/path"]]],["error",[["i"],[0]]],["value",[["s"],["battery:233"]]]]]
        for (const result of settingsResult) {
          if (result && Array.isArray(result)) {
            // Look for the ClassAndVrmInstance result
            const pathEntry = result.find(entry => entry && entry[0] === 'path');
            const valueEntry = result.find(entry => entry && entry[0] === 'value');
            
            if (pathEntry && valueEntry && 
                pathEntry[1] && pathEntry[1][1] && pathEntry[1][1][0] && pathEntry[1][1][0].includes('ClassAndVrmInstance') &&
                valueEntry[1] && valueEntry[1][1] && valueEntry[1][1][0]) {
              
              actualProposedInstance = valueEntry[1][1][0]; // Extract the actual assigned value
              const instanceMatch = actualProposedInstance.match(/battery:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Battery assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the DeviceInstance to match the assigned instance
                this.managementProperties['/DeviceInstance'] = { value: actualInstance, text: 'Device instance' };
              }
            }
          }
        }
      }

      // Also export the D-Bus interfaces for direct access using the same bus
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
          return this.wrapValue('s', actualProposedInstance);
        },
        SetValue: (val) => {
          return 0; // Success
        },
        GetText: () => {
          return 'Class and VRM instance';
        }
      };

      this.bus.exportInterface(classInterface, `/Settings/Devices/${serviceName}/ClassAndVrmInstance`, busItemInterface);

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

      this.bus.exportInterface(nameInterface, `/Settings/Devices/${serviceName}/CustomName`, busItemInterface);

      console.log(`Battery registered in Venus OS Settings: ${serviceName} -> ${actualProposedInstance}`);
      return actualInstance;
      
    } catch (err) {
      console.error('Failed to register battery in settings:', err.message);
      return batteryInstance || 100; // Fallback to default instance
    }
  }

  _exportMgmtSubtree() {
    // Define the BusItem interface descriptor for dbus-native
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

    // Management properties under /Mgmt/
    const mgmtProperties = {
      "/Mgmt/ProcessName": { type: "s", value: "signalk-battery-sensor", text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" }
    };

    // Create the /Mgmt subtree interface
    const mgmtInterface = {
      GetItems: () => {
        // Return all management properties under /Mgmt
        const items = [];
        Object.entries(mgmtProperties).forEach(([path, config]) => {
          items.push([path, {
            Value: this.wrapValue(config.type, config.value),
            Text: this.wrapValue("s", config.text)
          }]);
        });
        return items;
      },
      
      GetValue: () => {
        return this.wrapValue('s', 'Management');
      },
      
      SetValue: (value) => {
        return -1; // Error - mgmt subtree doesn't support setting values
      },
      
      GetText: () => {
        return 'Management';
      }
    };

    // Export the /Mgmt subtree interface
    if (!this.exportedInterfaces.has('/Mgmt')) {
      this.bus.exportInterface(mgmtInterface, "/Mgmt", busItemInterface);
      this.exportedInterfaces.add('/Mgmt');
    }

    // Export individual management property interfaces
    Object.entries(mgmtProperties).forEach(([path, config]) => {
      const propertyInterface = {
        GetValue: () => this.wrapValue(config.type, config.value),
        SetValue: (val) => 0, // Success
        GetText: () => config.text
      };

      // Only export if not already exported
      if (!this.exportedInterfaces.has(path)) {
        this.bus.exportInterface(propertyInterface, path, busItemInterface);
        this.exportedInterfaces.add(path);
        this.managementProperties[path] = { value: config.value, text: config.text };
      }
    });
  }

  async disconnect() {
    // Disconnect individual battery services
    for (const batteryService of this.batteryServices.values()) {
      if (batteryService) {
        batteryService.disconnect();
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
    this.batteryInstances.clear();
    this.batteryServices.clear();
    this.batteryCreating.clear(); // Clear race condition tracking
    this.exportedInterfaces.clear();
  }
}
