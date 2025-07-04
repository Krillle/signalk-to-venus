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
    this.tankServices = new Map(); // Track individual tank services
    this.exportedProperties = new Set(); // Track which D-Bus properties have been exported
    this.exportedInterfaces = new Set(); // Track which D-Bus interfaces have been exported
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
      
      // Don't register a main service name here - we'll register individual tank services
      
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

    // Device Instance - will be updated after Settings registration
    const deviceInstanceInterface = {
      GetValue: () => {
        return this.wrapValue('u', this.managementProperties['/DeviceInstance']?.value || 100);
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

    // Process Name
    const processNameInterface = {
      GetValue: () => {
        return this.wrapValue('s', 'signalk-tank');
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);
    this.managementProperties['/Mgmt/ProcessName'] = { value: 'signalk-tank', text: 'Process name' };

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
      
      // Create individual service for this tank
      await this._createTankService(tankInstance);
      
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

  _getTankName(path) {
    // Extract tank name from Signal K path
    const parts = path.split('.');
    if (parts.length >= 3) {
      const tankType = parts[1]; // e.g., 'fuel', 'freshWater', 'wasteWater'
      const tankLocation = parts[2]; // e.g., 'starboard', 'port', 'center'
      
      // Initialize tank counts if not exists
      if (!this.tankCounts[tankType]) {
        this.tankCounts[tankType] = 0;
      }
      this.tankCounts[tankType]++;
      
      // Create a descriptive name
      const typeNames = {
        fuel: 'Fuel',
        freshWater: 'Fresh Water',
        wasteWater: 'Waste Water',
        blackWater: 'Black Water',
        liveWell: 'Live Well',
        ballast: 'Ballast',
        rum: 'Rum'
      };
      
      const typeName = typeNames[tankType] || 'Unknown';
      const locationName = tankLocation.charAt(0).toUpperCase() + tankLocation.slice(1);
      
      return `${typeName} ${locationName}`;
    }
    
    return 'Unknown Tank';
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
      let actualInstance = tankInstance.index;
      
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
              const instanceMatch = actualProposedInstance.match(/tank:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Tank assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the tank instance to match the assigned instance
                tankInstance.actualInstance = actualInstance;
                tankInstance.vrmInstanceId = actualInstance;
              }
            }
          }
        }
      }

      console.log(`Tank registered in Venus OS Settings: ${serviceName} -> tank:${actualInstance}`);
      return actualInstance;
      
    } catch (err) {
      console.error(`Settings registration failed for tank ${tankInstance.basePath}:`, err);
      return tankInstance.index; // Fallback to hash-based index
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Skip if not connected
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
          this.tankData[levelPath] = levelPercent;
          this.emit('dataUpdated', 'Tank Level', `${tankName}: ${levelPercent.toFixed(1)}%`);
        }
      }
      else if (path.includes('capacity')) {
        // Validate and set capacity
        if (typeof value === 'number' && !isNaN(value)) {
          const capacityPath = `/Tank/${index}/Capacity`;
          this.tankData[capacityPath] = value;
          this.emit('dataUpdated', 'Tank Capacity', `${tankName}: ${value}L`);
        }
      }
      else if (path.includes('name')) {
        // Tank name/label
        if (typeof value === 'string') {
          const namePath = `/Tank/${index}/Name`;
          this.tankData[namePath] = value;
          this.emit('dataUpdated', 'Tank Name', `${tankName}: ${value}`);
        }
      }
      else if (path.includes('currentVolume')) {
        // Current volume in liters
        if (typeof value === 'number' && !isNaN(value)) {
          const volumePath = `/Tank/${index}/Volume`;
          this.tankData[volumePath] = value;
          this.emit('dataUpdated', 'Tank Volume', `${tankName}: ${value.toFixed(1)}L`);
        }
      }
      else if (path.includes('voltage')) {
        // Tank sensor voltage
        if (typeof value === 'number' && !isNaN(value)) {
          const voltagePath = `/Tank/${index}/Voltage`;
          this.tankData[voltagePath] = value;
          this.emit('dataUpdated', 'Tank Voltage', `${tankName}: ${value.toFixed(2)}V`);
        }
      }
      else {
        // Skip unknown tank properties silently
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
    }
    
    this.bus = null;
    this.tankData = {};
    this.tankInstances.clear();
    this.tankServices.clear();
    this.exportedInterfaces.clear();
    this.exportedProperties.clear();
    this.managementProperties = {};
  }

  async _createTankService(tankInstance) {
    // Check if we already have a service for this tank
    if (this.tankServices.has(tankInstance.basePath)) {
      return this.tankServices.get(tankInstance.basePath);
    }

    // Create a unique service name for this specific tank
    const serviceName = `com.victronenergy.virtual.tanks.signalk_tank_${tankInstance.basePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    try {
      // Request service name for this specific tank on our existing connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(serviceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Store the service name for this tank
      this.tankServices.set(tankInstance.basePath, serviceName);
      
      // Export management interfaces for this specific tank service
      await this._exportTankMgmt(serviceName, tankInstance);
      
      return serviceName;
      
    } catch (err) {
      throw new Error(`Failed to create tank service ${serviceName}: ${err.message}`);
    }
  }

  async _exportTankMgmt(serviceName, tankInstance) {
    // Define the BusItem interface descriptor
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

    // Export management properties for this tank service
    const deviceInstance = tankInstance.vrmInstanceId || tankInstance.index;
    
    // Management properties as specified in your Python version
    const managementProperties = {
      "/Mgmt/ProcessName": { type: "s", value: "signalk-tank-sensor", text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" },
      "/DeviceInstance": { type: "u", value: deviceInstance, text: "Device instance" },
      "/ProductId": { type: "u", value: 0xFFFF, text: "Product ID" },
      "/ProductName": { type: "s", value: "SignalK Virtual Tank", text: "Product name" },
      "/FirmwareVersion": { type: "s", value: "1.0.12", text: "Firmware version" },
      "/HardwareVersion": { type: "s", value: "1.0.0", text: "Hardware version" },
      "/Connected": { type: "i", value: 1, text: "Connected" },
      "/CustomName": { type: "s", value: tankInstance.name, text: "Custom name" }
    };

    // Export individual property interfaces for this tank service
    Object.entries(managementProperties).forEach(([path, config]) => {
      const propertyInterface = {
        GetValue: () => this.wrapValue(config.type, config.value),
        SetValue: (val) => 0, // Success
        GetText: () => config.text
      };

      // Create a unique interface key for this service and path
      const interfaceKey = `${serviceName}${path}`;
      
      // Only export if not already exported
      if (!this.exportedInterfaces.has(interfaceKey)) {
        this.bus.exportInterface(propertyInterface, path, busItemInterface);
        this.exportedInterfaces.add(interfaceKey);
      }
    });

    // Export root interface for this tank service
    const rootInterface = {
      GetItems: () => {
        // Return all management properties for this tank service
        const items = [];
        
        // Add management properties
        Object.entries(managementProperties).forEach(([path, config]) => {
          items.push([path, {
            Value: this.wrapValue(config.type, config.value),
            Text: this.wrapValue("s", config.text)
          }]);
        });

        // Add tank-specific data properties
        const tankPaths = [
          `/Tank/${deviceInstance}/Level`,
          `/Tank/${deviceInstance}/Capacity`,
          `/Tank/${deviceInstance}/Volume`,
          `/Tank/${deviceInstance}/Voltage`,
          `/Tank/${deviceInstance}/FluidType`,
          `/Tank/${deviceInstance}/Status`
        ];

        tankPaths.forEach(path => {
          const value = this.tankData[path] || 0;
          items.push([path, {
            Value: this.wrapValue('d', value),
            Text: this.wrapValue('s', 'Tank property')
          }]);
        });

        return items;
      },
      
      GetValue: () => {
        return this.wrapValue('s', `SignalK Virtual Tank - ${tankInstance.name}`);
      },
      
      SetValue: (value) => {
        return -1; // Error - root doesn't support setting values
      },
      
      GetText: () => {
        return `SignalK Virtual Tank - ${tankInstance.name}`;
      }
    };

    // Export root interface for this tank service
    const rootInterfaceKey = `${serviceName}/`;
    if (!this.exportedInterfaces.has(rootInterfaceKey)) {
      this.bus.exportInterface(rootInterface, "/", {
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
      });
      this.exportedInterfaces.add(rootInterfaceKey);
    }
  }
}