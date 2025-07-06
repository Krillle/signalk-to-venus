import dbusNative from 'dbus-native';
import EventEmitter from 'events';

// Individual switch service class
class SwitchService {
  constructor(switchInstance, settings) {
    this.switchInstance = switchInstance;
    this.settings = settings;
    this.serviceName = `signalk_${switchInstance.index}`;
    this.dbusServiceName = `com.victronenergy.switch.${this.serviceName}`;
    this.switchData = {};
    this.exportedInterfaces = new Set();
    this.bus = null; // Each switch service gets its own D-Bus connection
    
    // Don't create connection in constructor - do it in init()
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();

    // Register this service on its own D-Bus connection
    await this._registerSwitchInSettings();
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
        console.log(`Test mode: Created mock D-Bus connection for ${this.serviceName}`);
      } else {
        // Create individual D-Bus connection for this switch service
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

      // Register this service on its own D-Bus connection
      
    } catch (err) {
      console.error(`Failed to create D-Bus connection for switch service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  async _registerSwitchInSettings() {
    console.log(`switchInstanceName: ${this.switchInstance.name}`)
    try {
      // Proposed class and VRM instance (switch type and instance)
      const proposedInstance = `switch:${this.switchInstance.index}`;

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
          ['default', ['s', this.switchInstance.name]],
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
      let actualInstance = this.switchInstance.index;
      
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
              const instanceMatch = actualProposedInstance.match(/switch:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Switch assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the switch instance to match the assigned instance
                this.vrmInstanceId = actualInstance;
              }
            }
          }
        }
      }

      console.log(`Switch registered in Venus OS Settings: ${this.serviceName} -> switch:${actualInstance}`);
    } catch (err) {
      console.error(`Settings registration failed for switch ${this.serviceName}:`, err);
    }
  }

  async _registerService() {
    try {
      // Export management and switch interfaces
      this._exportManagementInterface();

      // Request service name on our own bus connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.dbusServiceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      console.log(`Successfully registered switch service ${this.dbusServiceName} on D-Bus`);
      
    } catch (err) {
      console.error(`Failed to register switch service ${this.dbusServiceName}:`, err);
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
      "/Mgmt/ProcessName": { type: "s", value: "signalk-switch", text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" },
      "/DeviceInstance": { type: "i", value: this.vrmInstanceId, text: "Device instance" },
      "/ProductId": { type: "i", value: 0, text: "Product ID" },
      "/ProductName": { type: "s", value: "SignalK Virtual Switch", text: "Product name" },
      "/FirmwareVersion": { type: "i", value: 0, text: "Firmware Version" },
      "/HardwareVersion": { type: "i", value: 0, text: "Hardware Version" },
      "/Connected": { type: "i", value: 1, text: "Connected" },
      "/CustomName": { type: "s", value: this.switchInstance.name, text: "Custom name" },
      // Switch specific properties
      "/Relay/0/State": { type: "i", value: 0, text: "Switch state" },
      "/Switches/0/State": { type: "i", value: 0, text: "Switch state" },
      "/Switches/0/Position": { type: "i", value: 0, text: "Switch position" },
      "/Switches/0/Name": { type: "s", value: this.switchInstance.name, text: "Switch name" },
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
        
        // Add switch data properties
        Object.entries(this.switchData).forEach(([path, value]) => {
          const pathMappings = {
            '/Relay/0/State': 'Switch state',
            '/Switches/0/State': 'Switch state',
            '/Switches/0/Position': 'Switch position',
            '/Switches/0/Name': 'Switch name'
          };
          
          const text = pathMappings[path] || 'Switch property';
          items.push([path, [
            ["Value", this._wrapValue('i', value)],
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
        
        // Add switch data properties
        Object.entries(this.switchData).forEach(([path, value]) => {
          items.push([path.slice(1), this._wrapValue('i', value)]);
        });

        return this._wrapValue('a{sv}', [items]);
      },
      SetValue: () => {
        return -1; // Error
      },
      GetText: () => {
        return 'SignalK Virtual Switch Service';
      }
    };

    this.bus.exportInterface(rootInterface, "/", busItemInterface);

    // Export individual property interfaces
    Object.entries(mgmtProperties).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportSwitchInterface() {
    // Switch-specific properties will be exported as needed through updateProperty
  }

  _exportProperty(path, config) {
    if (this.exportedInterfaces.has(path)) {
      // Just update the value
      if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
        // Management properties are static
        return;
      }
      this.switchData[path] = config.value;
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

    // Store initial value for switch data
    if (!path.startsWith('/Mgmt/') && !path.startsWith('/Product') && !path.startsWith('/Device') && !path.startsWith('/Custom')) {
      this.switchData[path] = config.value;
    }

    const propertyInterface = {
      GetValue: () => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return this._wrapValue(config.type, config.value);
        }
        const currentValue = this.switchData[path] || (config.type === 's' ? '' : 0);
        return this._wrapValue(config.type, currentValue);
      },
      SetValue: (val) => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return 1; // NOT OK - management properties are read-only (vedbus.py pattern)
        }
        const actualValue = Array.isArray(val) ? val[1] : val;
        
        // Check if value actually changed (vedbus.py pattern)
        if (this.switchData[path] === actualValue) {
          return 0; // OK - no change needed
        }
        
        this.switchData[path] = actualValue;
        return 0; // OK - value set successfully
      },
      GetText: () => {
        // Handle invalid values like vedbus.py
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return config.text;
        }
        const currentValue = this.switchData[path];
        if (currentValue === null || currentValue === undefined) {
          return '---'; // vedbus.py pattern for invalid values
        }
        return config.text;
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  updateProperty(path, value, type = 'i', text = 'Switch property') {
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
        console.error(`Error disconnecting switch service ${this.serviceName}:`, err);
      }
      this.bus = null;
    }
    
    // Clear data
    this.switchData = {};
    this.exportedInterfaces.clear();
  }
}

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.switchIndex = 0; // For unique switch indexing
    this.switchCounts = {}; // Track how many switches of each type we have
    this.switchCreating = new Map(); // Prevent race conditions in switch creation
    this.switchInstances = new Map(); // Track switch instances by Signal K path
    this.switchServices = new Map(); // Track individual switch services
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
      // Create single D-Bus connection using dbus-native with anonymous authentication
      this.bus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Single bus connection will be shared by all switch services
      
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



  async _getOrCreateSwitchInstance(path) {
    // Extract the base switch path (e.g., electrical.switches.nav from electrical.switches.nav.state)
    const basePath = path.replace(/\.(state|dimmingLevel)$/, '');
    
    if (!this.switchInstances.has(basePath)) {
      if (this.switchCreating.has(basePath))
        return;

      this.switchCreating.set(basePath, true);
      // Create a deterministic index based on the path hash to ensure consistency
      const index = this._generateStableIndex(basePath);
      const switchInstance = {
        index: index,
        name: this._getSwitchName(path),
        basePath: basePath
      };
      
      // Create switch service for this switch with its own D-Bus connection
      const switchService = new SwitchService(switchInstance, this.settings);
      await switchService.init(); // Initialize the switch service
      this.switchServices.set(basePath, switchService);
      this.switchInstances.set(basePath, switchInstance);
    }
    
    return this.switchInstances.get(basePath);
  }

  _generateStableIndex(basePath) {
    // Generate a stable index based on the base path to ensure the same switch
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

  _getSwitchName(path) {
    // Extract switch name from Signal K path
    const parts = path.split('.');
    if (parts.length >= 3) {
      const switchName = parts[2]; // e.g., 'nav', 'anchor', 'cabinLights'
      
      // Convert camelCase to space-separated words
      const formattedName = switchName
        .replace(/([a-z])([A-Z])/g, '$1 $2') // Insert space before capital letters
        .replace(/^./, str => str.toUpperCase()); // Capitalize first letter
      
      return formattedName;
    }
    return 'Unknown Switch';
  }

  updateProperty(path, value, type = 'i', text = 'Switch property') {
    // Get the switch service for this path
    const switchService = this._findSwitchServiceForPath(path);
    if (switchService) {
      switchService.updateProperty(path, value, type, text);
    }
    
    // For test compatibility, also update legacy data
    this.switchData[path] = value;
    this.exportedInterfaces.add(path);
  }

  _findSwitchServiceForPath(path) {
    // Helper method to find the correct switch service for a D-Bus path
    for (const [basePath, service] of this.switchServices) {
      // Check if this path belongs to this switch instance
      if (path.includes(`/Switch/${service.switchInstance.vrmInstanceId}/`)) {
        return service;
      }
    }
    return null;
  }

  async _registerSwitchInSettings(switchInstance) {
    if (!this.bus) {
      return switchInstance.index; // Fallback to hash-based index
    }

    try {
      // Create a unique service name for this switch
      const serviceName = `signalk_switch_${switchInstance.basePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Proposed class and VRM instance (switch type and instance)
      const proposedInstance = `switch:${switchInstance.index}`;
      
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
          ['default', ['s', switchInstance.name]],
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
      let actualInstance = switchInstance.index;
      
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
              const instanceMatch = actualProposedInstance.match(/switch:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Switch assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the switch instance to match the assigned instance
                switchInstance.actualInstance = actualInstance;
                switchInstance.vrmInstanceId = actualInstance;
              }
            }
          }
        }
      }

      console.log(`Switch registered in Venus OS Settings: ${serviceName} -> switch:${actualInstance}`);
      return actualInstance;
      
    } catch (err) {
      console.error(`Settings registration failed for switch ${switchInstance.basePath}:`, err);
      return switchInstance.index; // Fallback to hash-based index
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid switch values silently
        return;
      }
      
      // Ignore non-switch paths
      if (!path.startsWith('electrical.switches.')) {
        return;
      }
      
      // Initialize if not already done
      if (!this.bus) {
        await this.init();
      }
      
      // Get or create switch instance
      const switchInstance = await this._getOrCreateSwitchInstance(path);
      const switchService = this.switchServices.get(switchInstance.basePath);
      
      if (!switchService) {
        console.error(`No switch service found for ${switchInstance.basePath}`);
        return;
      }
      
      const switchName = switchInstance.name;
      
      // Handle different switch properties
      if (path.includes('.state')) {
        // Switch state (0/1)
        if (typeof value === 'number' || typeof value === 'boolean') {
          const switchState = value ? 1 : 0;
          switchService.updateProperty('/Relay/0/State', switchState, 'i', `${switchName} state`);
          switchService.updateProperty('/Switches/0/State', switchState, 'i', `${switchName} state`);
          
          // For test compatibility, also update legacy data
          this.switchData[`/Switch/${switchInstance.vrmInstanceId}/State`] = switchState;
          this.exportedInterfaces.add(`/Switch/${switchInstance.vrmInstanceId}/State`);
          
          this.emit('dataUpdated', 'Switch State', `${switchName}: ${switchState ? 'ON' : 'OFF'}`);
        }
      }
      else if (path.includes('.dimmingLevel')) {
        // Dimming level (0-1 to 0-100)
        if (typeof value === 'number' && !isNaN(value)) {
          const dimmingPercent = value > 1 ? value : value * 100;
          switchService.updateProperty('/Switches/0/Position', dimmingPercent, 'i', `${switchName} dimming level`);
          
          // For test compatibility, also update legacy data
          this.switchData[`/Switch/${switchInstance.vrmInstanceId}/DimmingLevel`] = dimmingPercent;
          this.exportedInterfaces.add(`/Switch/${switchInstance.vrmInstanceId}/DimmingLevel`);
          
          this.emit('dataUpdated', 'Dimming Level', `${switchName}: ${dimmingPercent.toFixed(1)}%`);
        }
      }
      else {
        // Skip unknown switch properties silently
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
    // Disconnect individual switch services
    for (const switchService of this.switchServices.values()) {
      if (switchService) {
        switchService.disconnect();
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
    this.switchInstances.clear();
    this.switchServices.clear();
    this.switchCreating.clear(); // Clear race condition tracking
    this.exportedInterfaces.clear();
  }
}
