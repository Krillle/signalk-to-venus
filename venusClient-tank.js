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
        return this.wrapValue('u', this.managementProperties['/DeviceInstance'].value);
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
    // Export root interface for VRM compatibility following vedbus.py format
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

    const rootImpl = {
      GetItems: () => {
        // Return all management properties and tank data in the correct vedbus.py format
        // Format: a{sa{sv}} - dictionary with string keys and variant values
        const items = {};
        
        // Add management properties
        Object.entries(this.managementProperties).forEach(([path, info]) => {
          items[path] = {
            Value: this.wrapValue(this.getType(info.value), info.value),
            Text: this.wrapValue('s', info.text)
          };
        });

        // Add tank data properties
        Object.entries(this.tankData).forEach(([path, value]) => {
          const tankPaths = {
            '/Tank/0/Level': 'Tank level',
            '/Tank/0/Capacity': 'Tank capacity',
            '/Tank/0/Volume': 'Tank volume',
            '/Tank/0/Voltage': 'Tank voltage',
            '/Tank/0/FluidType': 'Fluid type',
            '/Tank/0/Status': 'Tank status',
            '/Tank/1/Level': 'Tank level',
            '/Tank/1/Capacity': 'Tank capacity',
            '/Tank/1/Volume': 'Tank volume',
            '/Tank/1/Voltage': 'Tank voltage',
            '/Tank/1/FluidType': 'Fluid type',
            '/Tank/1/Status': 'Tank status'
          };
          
          const text = tankPaths[path] || 'Tank property';
          items[path] = {
            Value: this.wrapValue('d', value),
            Text: this.wrapValue('s', text)
          };
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

        // Add tank data properties (as relative paths from root)
        Object.entries(this.tankData).forEach(([path, value]) => {
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

        // Add tank data properties (as relative paths from root)
        Object.entries(this.tankData).forEach(([path, value]) => {
          const relativePath = path.startsWith('/') ? path.substring(1) : path;
          const tankPaths = {
            'Tank/0/Level': 'Tank level',
            'Tank/0/Capacity': 'Tank capacity',
            'Tank/0/Volume': 'Tank volume',
            'Tank/0/Voltage': 'Tank voltage',
            'Tank/0/FluidType': 'Fluid type',
            'Tank/0/Status': 'Tank status',
            'Tank/1/Level': 'Tank level',
            'Tank/1/Capacity': 'Tank capacity',
            'Tank/1/Volume': 'Tank volume',
            'Tank/1/Voltage': 'Tank voltage',
            'Tank/1/FluidType': 'Fluid type',
            'Tank/1/Status': 'Tank status'
          };
          texts[relativePath] = tankPaths[relativePath] || 'Tank property';
        });

        return texts;
      }
    };

    this.bus.exportInterface(rootImpl, '/', rootInterface);
  }

  async _getOrCreateTankInstance(path) {
    // Extract the base tank path (e.g., tanks.fuel.starboard from tanks.fuel.starboard.currentLevel)
    // We probably just need to remove everything after the last .?
    const basePath = path.replace(/\.(currentLevel|capacity|name|currentVolume|voltage)$/, '');
    
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
      else if (path.includes('currentVolume')) {
        // Current volume in liters
        if (typeof value === 'number' && !isNaN(value)) {
          const volumePath = `/Tank/${index}/Volume`;
          this._exportProperty(volumePath, { 
            value: value, 
            type: 'd', 
            text: `${tankName} volume` 
          });
          this.emit('dataUpdated', 'Tank Volume', `${tankName}: ${value.toFixed(1)}L`);
        }
      }
      else if (path.includes('voltage')) {
        // Tank sensor voltage
        if (typeof value === 'number' && !isNaN(value)) {
          const voltagePath = `/Tank/${index}/Voltage`;
          this._exportProperty(voltagePath, { 
            value: value, 
            type: 'd', 
            text: `${tankName} voltage` 
          });
          this.emit('dataUpdated', 'Tank Voltage', `${tankName}: ${value.toFixed(2)}V`);
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
    if (!this.bus) {
      return tankInstance.index; // Fallback to hash-based index
    }

    try {
      // Create a unique service name for this tank
      const serviceName = `signalk_tank_${tankInstance.basePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
      
      // Proposed class and VRM instance (tank type and instance)
      const proposedInstance = `tank:${tankInstance.index}`;
      
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
          ['default', ['s', tankInstance.name]],
          ['type', ['s', 's']],
          ['description', ['s', 'Custom name']]
        ]
      ];

      // Call the Venus OS Settings API to register the device using the same bus
      const settingsResult = await new Promise((resolve, reject) => {
        console.log('Invoking Settings API with:', JSON.stringify(settingsArray, null, 2));
        
        // Use the correct dbus-native message format with proper signature
        this.bus.message({
          type: 1, // methodCall
          destination: 'com.victronenergy.settings',
          path: '/',
          'interface': 'com.victronenergy.Settings',
          member: 'AddSettings',
          signature: 'aa{sv}',
          body: [settingsArray]
        });
        
        // Listen for the method return
        const onMessage = (msg) => {
          if (msg.type === 2 && msg.replySerial && msg.sender === 'com.victronenergy.settings') { // methodReturn
            this.bus.removeListener('message', onMessage);
            if (msg.errorName) {
              console.log('Settings API error:', msg.errorName, msg.body);
              reject(new Error(`Settings registration failed: ${msg.errorName}`));
            } else {
              console.log('Settings API result:', msg.body);
              resolve(msg.body);
            }
          }
        };
        
        this.bus.on('message', onMessage);
        
        // Set a timeout in case no response comes back
        setTimeout(() => {
          this.bus.removeListener('message', onMessage);
          reject(new Error('Settings registration timeout'));
        }, 5000);
      });

      // Extract the actual assigned instance ID from the Settings API result
      let actualInstance = tankInstance || 100;
      let actualProposedInstance = proposedInstance;
      
      if (settingsResult && settingsResult.length > 0) {
        // Parse the Settings API response format: [[["path",[["s"],["/path"]]],["error",[["i"],[0]]],["value",[["s"],["tank:233"]]]]]
        for (const result of settingsResult) {
          if (result && Array.isArray(result)) {
            // Look for the ClassAndVrmInstance result
            const pathEntry = result.find(entry => entry && entry[0] === 'path');
            const valueEntry = result.find(entry => entry && entry[0] === 'value');
            
            if (pathEntry && valueEntry && 
                pathEntry[1] && pathEntry[1][1] && pathEntry[1][1][0] && pathEntry[1][1][0].includes('ClassAndVrmInstance') &&
                valueEntry[1] && valueEntry[1][1] && valueEntry[1][1][0]) {
              
              actualProposedInstance = valueEntry[1][1][0]; // Extract the actual assigned value
              const instanceMatch = actualProposedInstance.match(/tank:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Tank assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
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

      // Export settings interfaces for direct D-Bus access
      const settingsPath = `${this.SETTINGS_ROOT}/${serviceName}`;
      
      const classInstancePath = `${settingsPath}/ClassAndVrmInstance`;
      const classInstanceInterface = {
        GetValue: () => {
          return this.wrapValue('s', actualProposedInstance);
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

      // Export the settings interfaces using the same bus
      this.bus.exportInterface(classInstanceInterface, classInstancePath, busItemInterface);
      this.bus.exportInterface(customNameInterface, customNamePath, busItemInterface);

      console.log(`Tank registered in Venus OS Settings: ${serviceName} -> ${actualProposedInstance}`);
      return actualInstance;

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
    
    this.tankData = {};
    this.tankInstances.clear();
    this.exportedProperties.clear();
    this.exportedInterfaces.clear();
  }
}