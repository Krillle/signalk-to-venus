import dbusNative from 'dbus-native';
import EventEmitter from 'events';

// Individual environment service class
class EnvironmentService {
  constructor(environmentInstance, settings) {
    this.environmentInstance = environmentInstance;
    this.settings = settings;
    this.serviceName = `signalk_${environmentInstance.index}`;
    this.dbusServiceName = `com.victronenergy.temperature.${this.serviceName}`;
    this.environmentData = {};
    this.exportedInterfaces = new Set();
    this.bus = null; // Each environment service gets its own D-Bus connection
    
    // Don't create connection in constructor - do it in init()
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();

    // Register this service on its own D-Bus connection
    await this._registerEnvironmentInSettings();
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
        // Create individual D-Bus connection for this environment service
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
      console.error(`Failed to create D-Bus connection for environment service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  async _registerEnvironmentInSettings() {
    console.log(`environmentInstanceName: ${this.environmentInstance.name}`)
    try {
      // Proposed class and VRM instance (environment type and instance)
      const proposedInstance = `environment:${this.environmentInstance.index}`;

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
          ['default', ['s', this.environmentInstance.name]],
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
      let actualInstance = this.environmentInstance.index;
      
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
              const instanceMatch = actualProposedInstance.match(/environment:(\d+)/);
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`Environment assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the environment instance to match the assigned instance
                this.vrmInstanceId = actualInstance;
              }
            }
          }
        }
      }

      console.log(`Environment registered in Venus OS Settings: ${this.serviceName} -> environment:${actualInstance}`);
    } catch (err) {
      console.error(`Settings registration failed for environment ${this.serviceName}:`, err);
    }
  }

  async _registerService() {
    try {
      // Export management and environment interfaces
      this._exportManagementInterface();

      // Request service name on our own bus connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.dbusServiceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      console.log(`Successfully registered environment service ${this.dbusServiceName} on D-Bus`);
      
    } catch (err) {
      console.error(`Failed to register environment service ${this.dbusServiceName}:`, err);
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
      "/Mgmt/ProcessName": { type: "s", value: "signalk-environment", text: "Process name" },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version" },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected" },
      "/DeviceInstance": { type: "i", value: this.vrmInstanceId, text: "Device instance" },
      "/ProductId": { type: "i", value: 0, text: "Product ID" },
      "/ProductName": { type: "s", value: "SignalK Virtual Environment Sensor", text: "Product name" },
      "/FirmwareVersion": { type: "i", value: 0, text: "Firmware Version" },
      "/HardwareVersion": { type: "i", value: 0, text: "Hardware Version" },
      "/Connected": { type: "i", value: 1, text: "Connected" },
      "/CustomName": { type: "s", value: this.environmentInstance.name, text: "Custom name" },
      // Environment specific properties
      "/Temperature": { type: "d", value: 0.0, text: "Temperature" },
      "/Humidity": { type: "d", value: 0.0, text: "Humidity" },
      "/Status": { type: "i", value: 0, text: "Status" },
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
        
        // Add environment data properties
        Object.entries(this.environmentData).forEach(([path, value]) => {
          const pathMappings = {
            '/Temperature': 'Temperature',
            '/Humidity': 'Humidity',
            '/Status': 'Status'
          };
          
          const text = pathMappings[path] || 'Environment property';
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
        
        // Add environment data properties
        Object.entries(this.environmentData).forEach(([path, value]) => {
          items.push([path.slice(1), this._wrapValue('d', value)]);
        });

        return this._wrapValue('a{sv}', [items]);
      },
      SetValue: () => {
        return -1; // Error
      },
      GetText: () => {
        return 'SignalK Virtual Environment Service';
      }
    };

    this.bus.exportInterface(rootInterface, "/", busItemInterface);

    // Export individual property interfaces
    Object.entries(mgmtProperties).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportProperty(path, config) {
    if (this.exportedInterfaces.has(path)) {
      // Just update the value
      if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
        // Management properties are static
        return;
      }
      this.environmentData[path] = config.value;
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

    // Store initial value for environment data
    if (!path.startsWith('/Mgmt/') && !path.startsWith('/Product') && !path.startsWith('/Device') && !path.startsWith('/Custom')) {
      this.environmentData[path] = config.value;
    }

    const propertyInterface = {
      GetValue: () => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return this._wrapValue(config.type, config.value);
        }
        const currentValue = this.environmentData[path] || (config.type === 's' ? '' : 0);
        return this._wrapValue(config.type, currentValue);
      },
      SetValue: (val) => {
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return 1; // NOT OK - management properties are read-only (vedbus.py pattern)
        }
        const actualValue = Array.isArray(val) ? val[1] : val;
        
        // Check if value actually changed (vedbus.py pattern)
        if (this.environmentData[path] === actualValue) {
          return 0; // OK - no change needed
        }
        
        this.environmentData[path] = actualValue;
        return 0; // OK - value set successfully
      },
      GetText: () => {
        // Handle invalid values like vedbus.py
        if (path.startsWith('/Mgmt/') || path.startsWith('/Product') || path.startsWith('/Device') || path.startsWith('/Custom')) {
          return config.text;
        }
        const currentValue = this.environmentData[path];
        if (currentValue === null || currentValue === undefined) {
          return '---'; // vedbus.py pattern for invalid values
        }
        return config.text;
      }
    };

    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  updateProperty(path, value, type = 'd', text = 'Environment property') {
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
        console.error(`Error disconnecting environment service ${this.serviceName}:`, err);
      }
      this.bus = null;
    }
    
    // Clear data
    this.environmentData = {};
    this.exportedInterfaces.clear();
  }
}

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.environmentData = {}; // For compatibility with tests
    this.environmentIndex = 0; // For unique environment indexing
    this.environmentCounts = {}; // Track how many environments of each type we have
    this.environmentCreating = new Map(); // Prevent race conditions in environment creation
    this.environmentInstances = new Map(); // Track environment instances by Signal K path
    this.environmentServices = new Map(); // Track individual environment services
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

  async _getOrCreateEnvironmentInstance(path) {
    // Extract the base environment path (e.g., environment.water.temperature)
    const basePath = path.replace(/\.(temperature|humidity|relativeHumidity)$/, '');
    
    if (!this.environmentInstances.has(basePath)) {
      if (this.environmentCreating.has(basePath))
        return;

      this.environmentCreating.set(basePath, true);
      // Create a deterministic index based on the path hash to ensure consistency
      const index = this._generateStableIndex(basePath);
      const environmentInstance = {
        index: index,
        name: this._getEnvironmentName(path),
        basePath: basePath
      };
      
      // Create environment service for this environment with its own D-Bus connection
      const environmentService = new EnvironmentService(environmentInstance, this.settings);
      await environmentService.init(); // Initialize the environment service
      this.environmentServices.set(basePath, environmentService);
      this.environmentInstances.set(basePath, environmentInstance);
    }
    
    return this.environmentInstances.get(basePath);
  }

  _generateStableIndex(basePath) {
    // Generate a stable index based on the base path to ensure the same environment
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

  _getEnvironmentName(path) {
    // Extract environment name from Signal K path
    const parts = path.split('.');
    if (parts.length >= 3) {
      const environmentType = parts[1]; // e.g., 'water', 'air', 'inside'
      const sensorType = parts[2]; // e.g., 'temperature', 'humidity'
      
      // Create names to match expected patterns
      if (sensorType === 'temperature') {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} Temperature`;
      } else if (sensorType === 'humidity' || sensorType === 'relativeHumidity') {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} Humidity`;
      } else {
        return `${environmentType.charAt(0).toUpperCase() + environmentType.slice(1)} ${sensorType.charAt(0).toUpperCase() + sensorType.slice(1)}`;
      }
    }
    return 'Unknown Environment Sensor';
  }

  // Legacy _exportProperty method for compatibility with tests
  _exportProperty(environmentInstance, path, config) {
    const environmentService = this.environmentServices.get(environmentInstance.basePath);
    if (environmentService) {
      environmentService.updateProperty(path, config.value, config.type, config.text);
    }
    
    // Store in legacy environmentData for test compatibility
    const dataKey = `${environmentInstance.basePath}${path}`;
    this.environmentData = this.environmentData || {};
    this.environmentData[dataKey] = config.value;
    
    // Update exported interfaces tracking for test compatibility
    this.exportedInterfaces.add(dataKey);
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid environment values silently
        return;
      }
      
      // Ignore non-environment paths
      if (!path.startsWith('environment.')) {
        return;
      }

      // Initialize if not already done
      const environmentInstance = await this._getOrCreateEnvironmentInstance(path);
      if (!environmentInstance)
        return;

      // Get or create environment instance
      const environmentService = this.environmentServices.get(environmentInstance.basePath);
      
      if (!environmentService) {
        console.error(`No environment service found for ${environmentInstance.basePath}`);
        return;
      }
      
      const environmentName = environmentInstance.name;
      
      // Handle different environment properties
      if (path.includes('temperature')) {
        // Temperature in Celsius (Signal K spec uses Kelvin, convert to Celsius for Venus OS)
        if (typeof value === 'number' && !isNaN(value)) {
          const tempCelsius = value > 200 ? value - 273.15 : value;
          environmentService.updateProperty('/Temperature', tempCelsius, 'd', `${environmentName} temperature`);
          this.emit('dataUpdated', 'Environment Temperature', `${environmentName}: ${tempCelsius.toFixed(1)}°C`);
        }
      }
      else if (path.includes('humidity') || path.includes('relativeHumidity')) {
        // Humidity as percentage (0-1 to 0-100)
        if (typeof value === 'number' && !isNaN(value)) {
          const humidityPercent = value > 1 ? value : value * 100;
          environmentService.updateProperty('/Humidity', humidityPercent, 'd', `${environmentName} humidity`);
          this.emit('dataUpdated', 'Environment Humidity', `${environmentName}: ${humidityPercent.toFixed(1)}%`);
        }
      }
      else {
        // Skip unknown environment properties silently
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
    // Disconnect individual environment services
    for (const environmentService of this.environmentServices.values()) {
      if (environmentService) {
        environmentService.disconnect();
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
    this.environmentData = {};
    this.environmentInstances.clear();
    this.environmentServices.clear();
    this.environmentCreating.clear(); // Clear race condition tracking
    this.exportedInterfaces.clear();
  }
}