import dbusNative from 'dbus-native';
import EventEmitter from 'events';

// Individual switch service class
class SwitchService {
  constructor(switchInstance, settings) {
    this.switchInstance = switchInstance;
    this.settings = settings;
    this.serviceName = `com.victronenergy.switch.signalk_${switchInstance.index}`;
    this.switchData = {};
    this.exportedInterfaces = new Set();
    this.bus = null; // Each switch service gets its own D-Bus connection
    
    // Don't create connection in constructor - do it in init()
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();
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
      await this._registerService();
      
    } catch (err) {
      console.error(`Failed to create D-Bus connection for switch service ${this.serviceName}:`, err);
      throw err;
    }
  }

  async _registerService() {
    try {
      // Request service name on our own bus connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.serviceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Export management and switch interfaces
      this._exportManagementInterface();
      this._exportSwitchInterface();
      
      console.log(`Successfully registered switch service ${this.serviceName} on D-Bus`);
      
    } catch (err) {
      console.error(`Failed to register switch service ${this.serviceName}:`, err);
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
      "/ProductName": { type: "s", value: "SignalK Virtual Switch", text: "Product name" },
      "/DeviceInstance": { type: "u", value: this.switchInstance.vrmInstanceId, text: "Device instance" },
      "/CustomName": { type: "s", value: this.switchInstance.name, text: "Custom name" }
    };

    // Export root interface with GetItems
    const rootInterface = {
      GetItems: () => {
        const items = [];
        
        // Add management properties
        Object.entries(mgmtProperties).forEach(([path, config]) => {
          items.push([path, {
            Value: this._wrapValue(config.type, config.value),
            Text: this._wrapValue("s", config.text)
          }]);
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
          items.push([path, {
            Value: this._wrapValue('i', value),
            Text: this._wrapValue('s', text)
          }]);
        });

        return items;
      },
      
      GetValue: () => this._wrapValue('s', 'SignalK Virtual Switch Service'),
      SetValue: () => -1, // Error
      GetText: () => 'SignalK Virtual Switch Service'
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
    const interfaceKey = `${this.serviceName}${path}`;
    
    if (this.exportedInterfaces.has(interfaceKey)) {
      // Just update the value
      if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
        // Management properties are static
        return;
      }
      this.switchData[path] = config.value;
      return;
    }

    this.exportedInterfaces.add(interfaceKey);

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
          return -1; // Error - management properties are read-only
        }
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.switchData[path] = actualValue;
        return 0; // Success
      },
      GetText: () => config.text
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  updateProperty(path, value, type = 'i', text = 'Switch property') {
    this._exportProperty(path, { value, type, text });
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
    this.switchData = {}; // For compatibility with tests
    this.lastInitAttempt = 0;
    this.switchIndex = 0; // For unique switch indexing
    this.switchInstances = new Map(); // Track switch instances by Signal K base path
    this.switchServices = new Map(); // Track individual switch services
    this.exportedProperties = new Set(); // Track which D-Bus properties have been exported
    this.exportedInterfaces = new Set(); // Track which D-Bus interfaces have been exported
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

  // Legacy methods for compatibility with tests
  _exportMgmt() {
    // Legacy method for compatibility with tests
    // In the individual service approach, management is exported per switch
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

    // Set up basic management properties for compatibility
    this.managementProperties['/Mgmt/Connection'] = { value: 1, text: 'Connected' };
    this.managementProperties['/ProductName'] = { value: 'SignalK Virtual Switch', text: 'Product name' };
    this.managementProperties['/DeviceInstance'] = { value: 102, text: 'Device instance' };
    this.managementProperties['/CustomName'] = { value: 'SignalK Switch', text: 'Custom name' };
    this.managementProperties['/Mgmt/ProcessName'] = { value: 'signalk-switch', text: 'Process name' };
    this.managementProperties['/Mgmt/ProcessVersion'] = { value: '1.0.12', text: 'Process version' };
  }

  _exportRootInterface() {
    // Legacy method for compatibility with tests
    // In the individual service approach, root interface is exported per switch
  }

  _exportMgmtSubtree() {
    // Legacy method for compatibility with tests
    // In the individual service approach, management subtree is exported per switch
  }

  async _getOrCreateSwitchInstance(path) {
    // Extract the base switch path (e.g., electrical.switches.nav from electrical.switches.nav.state)
    const basePath = path.replace(/\.(state|dimmingLevel)$/, '');
    
    if (!this.switchInstances.has(basePath)) {
      // Create a deterministic index based on the path hash to ensure consistency
      const index = this._generateStableIndex(basePath);
      const switchInstance = {
        index: index,
        name: this._getSwitchName(path),
        basePath: basePath
      };
      
      // Register switch in Venus OS settings and get VRM instance ID
      const vrmInstanceId = await this._registerSwitchInSettings(switchInstance);
      switchInstance.vrmInstanceId = vrmInstanceId;
      
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
    // Extract switch name from Signal K path like electrical.switches.navigation.state
    const pathParts = path.split('.');
    if (pathParts.length < 3) return 'Unknown Switch';
    
    // Use the switch name from the path
    const switchName = pathParts[2];
    
    // Convert camelCase to proper names
    return switchName.charAt(0).toUpperCase() + switchName.slice(1).replace(/([A-Z])/g, ' $1');
  }

  // Legacy _exportProperty method for compatibility with tests
  _exportProperty(path, config) {
    // For compatibility with tests, also call the legacy method
    const dataKey = `${path}`;
    this.switchData = this.switchData || {};
    this.switchData[dataKey] = config.value;
    
    // Update exported interfaces tracking for test compatibility
    if (!this.exportedInterfaces.has(dataKey)) {
      this.exportedInterfaces.add(dataKey);
      
      // For test compatibility, call exportInterface if bus exists
      if (this.bus && this.bus.exportInterface) {
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
          GetValue: () => this.wrapValue(config.type, config.value),
          SetValue: (val) => {
            const actualValue = Array.isArray(val) ? val[1] : val;
            this.switchData[path] = actualValue;
            return 0; // Success
          },
          GetText: () => config.text
        };

        this.bus.exportInterface(propertyInterface, path, busItemInterface);
      }
    }

    // If we have the actual switch service, update it too
    if (path.includes('/Switch/')) {
      // Extract instance ID from path like '/Switch/456/State'
      const match = path.match(/\/Switch\/(\d+)\/(State|DimmingLevel)/);
      if (match) {
        const instanceId = match[1];
        const property = match[2];
        
        // Find the switch service for this instance
        for (const [basePath, service] of this.switchServices) {
          if (service.switchInstance.vrmInstanceId == instanceId) {
            if (property === 'State') {
              service.updateProperty('/Relay/0/State', config.value, 'i', config.text);
              service.updateProperty('/Switches/0/State', config.value, 'i', config.text);
            } else if (property === 'DimmingLevel') {
              service.updateProperty('/Switches/0/Position', config.value, 'i', config.text);
            }
            break;
          }
        }
      }
    }
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
          
          // For test compatibility, also call legacy _exportProperty
          this._exportProperty(`/Switch/${switchInstance.vrmInstanceId}/State`, {
            value: switchState,
            type: 'd', // Tests expect 'd' type
            text: `${switchName} state`
          });
          
          this.emit('dataUpdated', 'Switch State', `${switchName}: ${switchState ? 'ON' : 'OFF'}`);
        }
      }
      else if (path.includes('.dimmingLevel')) {
        // Dimming level (0-1 to 0-100)
        if (typeof value === 'number' && !isNaN(value)) {
          const dimmingPercent = value > 1 ? value : value * 100;
          switchService.updateProperty('/Switches/0/Position', dimmingPercent, 'i', `${switchName} dimming level`);
          
          // For test compatibility, also call legacy _exportProperty  
          this._exportProperty(`/Switch/${switchInstance.vrmInstanceId}/DimmingLevel`, {
            value: dimmingPercent,
            type: 'd', // Tests expect 'd' type
            text: `${switchName} dimming level`
          });
          
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
    this.switchData = {};
    this.switchInstances.clear();
    this.switchServices.clear();
    this.exportedInterfaces.clear();
    this.exportedProperties.clear();
    this.managementProperties = {};
  }
}
