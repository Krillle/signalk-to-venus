import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.switchData = {};
    this.lastInitAttempt = 0;
    this.switchIndex = 0; // For unique switch indexing
    this.switchInstances = new Map(); // Track switch instances by Signal K base path
    this.exportedProperties = new Set(); // Track which D-Bus properties have been exported
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
      this._exportRootInterface(); // Export root interface for VRM compatibility
      
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
    // Define the BusItem interface descriptor with enhanced signatures
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

    // Export management properties
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
        return this.wrapValue('s', 'SignalK Virtual Switch');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    this.bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);
    this.managementProperties['/ProductName'] = { value: 'SignalK Virtual Switch', text: 'Product name' };

    // Device Instance - Required for unique identification
    const deviceInstanceInterface = {
      GetValue: () => {
        return this.wrapValue('u', 102); // Unsigned integer for device instance
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    this.bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);
    this.managementProperties['/DeviceInstance'] = { value: 102, text: 'Device instance' };

    // Custom Name
    const customNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'SignalK Switch');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Custom name';
      }
    };

    this.bus.exportInterface(customNameInterface, '/CustomName', busItemInterface);
    this.managementProperties['/CustomName'] = { value: 'SignalK Switch', text: 'Custom name' };

    // Process Name and Version - Required for VRM registration
    const processNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'signalk-switch-sensor');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);
    this.managementProperties['/Mgmt/ProcessName'] = { value: 'signalk-switch-sensor', text: 'Process name' };

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

  _exportRootInterface() {
    // Export root interface for VRM compatibility
    const rootInterface = {
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

    const rootImpl = {
      GetValue: () => {
        return this.wrapValue('s', 'SignalK Virtual Switch Service');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'SignalK Virtual Switch Service';
      }
    };

    this.bus.exportInterface(rootImpl, '/', rootInterface);
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

  _exportProperty(path, config) {
    // Use a composite key to track both the D-Bus path and the interface
    const interfaceKey = `${path}`;
    
    // Only export if not already exported
    if (this.exportedInterfaces.has(interfaceKey)) {
      // Just update the value, don't re-export the interface
      this.switchData[path] = config.value;
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
    this.switchData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return this.wrapValue(config.type, this.switchData[path] || (config.type === 's' ? '' : 0));
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.switchData[path] = actualValue;
        this.emit('valueChanged', path, actualValue);
        return 0; // Success
      },
      GetText: () => {
        return config.text; // Native string return
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  _updateValue(path, value) {
    if (this.switchData.hasOwnProperty(path)) {
      this.switchData[path] = value;
    }
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

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid switch values silently
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
      
      const switchInstance = await this._getOrCreateSwitchInstance(path);
      const switchName = switchInstance.name;
      const index = switchInstance.vrmInstanceId || switchInstance.index;
      
      if (path.includes('state')) {
        // Switch state (0 = off, 1 = on)
        const switchState = value ? 1 : 0;
        const statePath = `/Switch/${index}/State`;
        this._exportProperty(statePath, { 
          value: switchState, 
          type: 'd', 
          text: `${switchName} state` 
        });
        this.emit('dataUpdated', 'Switch State', `${switchName}: ${value ? 'ON' : 'OFF'}`);
      }
      else if (path.includes('dimmingLevel')) {
        // Dimming level (0-1 to 0-100 percentage)
        if (typeof value === 'number' && !isNaN(value)) {
          const dimmingPercent = value * 100;
          const dimmingPath = `/Switch/${index}/DimmingLevel`;
          this._exportProperty(dimmingPath, { 
            value: dimmingPercent, 
            type: 'd', 
            text: `${switchName} dimming level` 
          });
          this.emit('dataUpdated', 'Switch Dimming', `${switchName}: ${dimmingPercent.toFixed(1)}%`);
        }
      }
      else {
        // Silently ignore unknown switch paths
        // Silently ignore unknown switch paths
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
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
    
    this.switchData = {};
    this.switchInstances.clear();
    this.exportedProperties.clear();
    this.exportedInterfaces.clear();
  }

  async _registerSwitchInSettings(switchInstance) {
    if (!this.settingsBus) {
      return switchInstance.index; // Fallback to hash-based index
    }

    try {
      // Create a unique service name for this switch
      const serviceName = `signalk_switch_${switchInstance.basePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const settingsPath = `${this.SETTINGS_ROOT}/${serviceName}`;
      
      // Proposed class and VRM instance (switch type and instance)
      const proposedInstance = `switch:${switchInstance.index}`;
      
      // Define the BusItem interface descriptor for settings
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

      // ClassAndVrmInstance setting
      const classInstancePath = `${settingsPath}/ClassAndVrmInstance`;
      const classInstanceInterface = {
        GetValue: () => {
          return this.wrapValue('s', proposedInstance);
        },
        SetValue: (val) => {
          // Allow VRM to change our instance
          const actualValue = Array.isArray(val) ? val[1] : val;
          return 0; // Success
        },
        GetText: () => {
          return 'Class and VRM instance';
        }
      };

      // CustomName setting
      const customNamePath = `${settingsPath}/CustomName`;
      const customNameInterface = {
        GetValue: () => {
          return this.wrapValue('s', switchInstance.name);
        },
        SetValue: (val) => {
          const actualValue = Array.isArray(val) ? val[1] : val;
          return 0; // Success
        },
        GetText: () => {
          return 'Custom name';
        }
      };

      // Export the settings interfaces
      this.settingsBus.exportInterface(classInstanceInterface, classInstancePath, busItemInterface);
      this.settingsBus.exportInterface(customNameInterface, customNamePath, busItemInterface);

      // Extract instance ID from the proposed instance string
      const instanceMatch = proposedInstance.match(/:(\d+)$/);
      return instanceMatch ? parseInt(instanceMatch[1]) : switchInstance.index;

    } catch (err) {
      // Fallback to hash-based index if settings registration fails
      return switchInstance.index;
    }
  }
}
