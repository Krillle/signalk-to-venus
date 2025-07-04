import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.tankData = {};
    this.lastInitAttempt = 0;
    this.tankIndex = 0; // For unique tank indexing
    this.tankCounts = {}; // Track how many tanks of each type we have
    this.tankInstances = new Map(); // Track tank instances by Signal K base path
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
        return this.wrapValue('s', 'SignalK Virtual Tank');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    this.bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);
    this.managementProperties['/ProductName'] = { value: 'SignalK Virtual Tank', text: 'Product name' };

    // Device Instance - Required for unique identification
    const deviceInstanceInterface = {
      GetValue: () => {
        return this.wrapValue('u', 101); // Base device instance for tank service
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    this.bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);
    this.managementProperties['/DeviceInstance'] = { value: 101, text: 'Device instance' };

    // Custom Name
    const customNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'SignalK Tank');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Custom name';
      }
    };

    this.bus.exportInterface(customNameInterface, '/CustomName', busItemInterface);
    this.managementProperties['/CustomName'] = { value: 'SignalK Tank', text: 'Custom name' };

    // Process Name and Version - Required for VRM registration
    const processNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'signalk-tank-sensor');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);
    this.managementProperties['/Mgmt/ProcessName'] = { value: 'signalk-tank-sensor', text: 'Process name' };

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
        return this.wrapValue('s', 'SignalK Virtual Tank Service');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'SignalK Virtual Tank Service';
      }
    };

    this.bus.exportInterface(rootImpl, '/', rootInterface);
  }

  async _getOrCreateTankInstance(path) {
    // Extract the base tank path (e.g., tanks.fuel.starboard from tanks.fuel.starboard.currentLevel)
    const basePath = path.replace(/\.(currentLevel|capacity|name)$/, '');
    
    if (!this.tankInstances.has(basePath)) {
      // Create a deterministic index based on the path hash to ensure consistency
      const index = this._generateStableIndex(basePath);
      const tankInstance = {
        index: index,
        name: this._getTankName(path),
        basePath: basePath
      };
      
      // Register tank in Venus OS settings and get VRM instance ID
      const vrmInstanceId = await this._registerTankInSettings(tankInstance);
      tankInstance.vrmInstanceId = vrmInstanceId;
      
      this.tankInstances.set(basePath, tankInstance);
    }
    
    return this.tankInstances.get(basePath);
  }

  _generateStableIndex(basePath) {
    // Generate a stable index based on the base path to ensure the same tank
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
      this.tankData[path] = config.value;
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
    this.tankData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return this.wrapValue(config.type, this.tankData[path] || (config.type === 's' ? '' : 0));
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.tankData[path] = actualValue;
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
    if (this.tankData.hasOwnProperty(path)) {
      this.tankData[path] = value;
    }
  }

  _getTankName(path) {
    // Extract tank type and ID from Signal K path like tanks.fuel.starboard.currentLevel
    const pathParts = path.split('.');
    if (pathParts.length < 3) return 'Tank';
    
    const tankType = pathParts[1]; // fuel, freshWater, etc.
    const tankId = pathParts[2]; // any alphanumeric string (not just numbers!)
    
    // Convert camelCase to proper names
    const typeNames = {
      'fuel': 'Fuel',
      'freshWater': 'Freshwater', 
      'wasteWater': 'Wastewater',
      'blackWater': 'Blackwater',
      'lubrication': 'Lubrication',
      'liveWell': 'Livewell',
      'baitWell': 'Baitwell', 
      'gas': 'Gas',
      'ballast': 'Ballast'
    };
    
    const typeName = typeNames[tankType] || tankType.charAt(0).toUpperCase() + tankType.slice(1);
    
    // Count how many tanks of this type we have seen
    if (!this.tankCounts[tankType]) {
      this.tankCounts[tankType] = [];
    }
    if (!this.tankCounts[tankType].includes(tankId)) {
      this.tankCounts[tankType].push(tankId);
    }
    
    // Always include the tank ID unless it's a generic single tank
    if (this.tankCounts[tankType].length === 1 && (tankId === '0' || tankId === 'main' || tankId === 'primary')) {
      // Single tank with generic ID - just use type name
      return typeName;
    } else {
      // Multiple tanks or specific ID - include the ID
      return `${typeName} ${tankId}`;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid tank values silently
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
      
      const tankInstance = await this._getOrCreateTankInstance(path);
      const tankName = tankInstance.name;
      const index = tankInstance.vrmInstanceId || tankInstance.index;
      
      if (path.includes('currentLevel')) {
        // Validate and convert level (0-1 to 0-100 percentage)
        if (typeof value === 'number' && !isNaN(value)) {
          const levelPath = `/Tank/${index}/Level`;
          const levelPercent = value * 100;
          this._exportProperty(levelPath, { 
            value: levelPercent, 
            type: 'd', 
            text: `${tankName} level` 
          });
          this.emit('dataUpdated', 'Tank Level', `${tankName}: ${levelPercent.toFixed(1)}%`);
        }
      }
      else if (path.includes('capacity')) {
        // Validate and set capacity
        if (typeof value === 'number' && !isNaN(value)) {
          const capacityPath = `/Tank/${index}/Capacity`;
          this._exportProperty(capacityPath, { 
            value: value, 
            type: 'd', 
            text: `${tankName} capacity` 
          });
          this.emit('dataUpdated', 'Tank Capacity', `${tankName}: ${value}L`);
        }
      }
      else if (path.includes('name')) {
        // Tank name/label
        if (typeof value === 'string') {
          const namePath = `/Tank/${index}/Name`;
          this._exportProperty(namePath, { 
            value: value, 
            type: 's', 
            text: `${tankName} name` 
          });
          this.emit('dataUpdated', 'Tank Name', `${tankName}: ${value}`);
        }
      }
      else {
        // Silently ignore unknown tank paths
        // Silently ignore unknown tank paths
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async _registerTankInSettings(tankInstance) {
    if (!this.settingsBus) {
      return tankInstance.index; // Fallback to hash-based index
    }

    try {
      // Create a unique service name for this tank
      const serviceName = `signalk_tank_${tankInstance.basePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Proposed class and VRM instance (tank type and instance)
      const proposedInstance = `tank:${tankInstance.index}`;
      
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
          'default': [tankInstance.name],
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

      // Export settings interfaces for direct D-Bus access
      const settingsPath = `${this.SETTINGS_ROOT}/${serviceName}`;
      
      const classInstancePath = `${settingsPath}/ClassAndVrmInstance`;
      const classInstanceInterface = {
        GetValue: () => {
          return this.wrapValue('s', proposedInstance);
        },
        SetValue: (val) => {
          const actualValue = Array.isArray(val) ? val[1] : val;
          return 0; // Success
        },
        GetText: () => {
          return 'Class and VRM instance';
        }
      };

      const customNamePath = `${settingsPath}/CustomName`;
      const customNameInterface = {
        GetValue: () => {
          return this.wrapValue('s', tankInstance.name);
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
      return instanceMatch ? parseInt(instanceMatch[1]) : tankInstance.index;

    } catch (err) {
      console.error(`Settings registration failed for tank ${tankInstance.basePath}:`, err);
      // Fallback to hash-based index if settings registration fails
      return tankInstance.index;
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
    
    this.tankData = {};
    this.tankInstances.clear();
    this.exportedProperties.clear();
    this.exportedInterfaces.clear();
  }
}