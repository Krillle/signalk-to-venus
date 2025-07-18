import dbusNative from 'dbus-native';
import EventEmitter from 'events';

/**
 * Central VEDBus service class inspired by velib_python/vedbus.py
 * This class provides a common D-Bus service implementation for all Venus OS devices
 */
export class VEDBusService extends EventEmitter {
  constructor(serviceName, deviceInstance, settings, deviceConfig) {
    super();
    this.serviceName = serviceName;
    this.deviceInstance = deviceInstance;
    this.settings = settings;
    this.deviceConfig = deviceConfig;
    this.dbusServiceName = `com.victronenergy.${deviceConfig.serviceType}.${serviceName}`;
    this.deviceData = {};
    this.exportedInterfaces = {};
    this.bus = null;
    this.vrmInstanceId = deviceInstance.index;
    
    // Management properties that are common to all devices
    this.managementProperties = {
      "/Mgmt/ProcessName": { type: "s", value: deviceConfig.processName, text: "Process name", immutable: true },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version", immutable: true },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected", immutable: true },
      "/DeviceInstance": { type: "i", value: this.vrmInstanceId, text: "Device instance", immutable: true },
      "/ProductId": { type: "i", value: 0, text: "Product ID", immutable: true },
      "/ProductName": { type: "s", value: deviceConfig.productName, text: "Product name", immutable: true },
      "/FirmwareVersion": { type: "i", value: 0, text: "Firmware Version", immutable: true },
      "/HardwareVersion": { type: "i", value: 0, text: "Hardware Version", immutable: true },
      "/Connected": { type: "i", value: 1, text: "Connected", immutable: true },
      "/CustomName": { type: "s", value: deviceInstance.name, text: "Custom name" },
      ...deviceConfig.additionalProperties
    };
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();
    await this._registerInSettings();
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
          end: () => {},
          invoke: (options, callback) => callback(null, [])
        };
        console.log(`Test mode: Created mock D-Bus connection for ${this.dbusServiceName}`);
      } else {
        // Create individual D-Bus connection for this service
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
      console.error(`Failed to create D-Bus connection for ${this.deviceConfig.serviceType} service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  async _registerInSettings() {
    console.log(`${this.deviceConfig.serviceType}InstanceName: ${this.deviceInstance.name}`)
    try {
      // Proposed class and VRM instance
      const proposedInstance = `${this.deviceConfig.serviceType}:${this.deviceInstance.index}`;

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
          ['default', ['s', this.deviceInstance.name]],
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
      let actualInstance = this.deviceInstance.index;
      
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
              const instanceMatch = actualProposedInstance.match(new RegExp(`${this.deviceConfig.serviceType}:(\\d+)`));
              if (instanceMatch) {
                actualInstance = parseInt(instanceMatch[1]);
                console.log(`${this.deviceConfig.serviceType} assigned actual instance: ${actualInstance} (${actualProposedInstance})`);
                
                // Update the instance to match the assigned instance
                this.vrmInstanceId = actualInstance;
                this.managementProperties["/DeviceInstance"].value = actualInstance;
              }
            }
          }
        }
      }

      console.log(`${this.deviceConfig.serviceType} registered in Venus OS Settings: ${this.serviceName} -> ${this.deviceConfig.serviceType}:${actualInstance}`);
    } catch (err) {
      console.error(`Settings registration failed for ${this.deviceConfig.serviceType} ${this.serviceName}:`, err);
    }
  }

  async _registerService() {
    try {
      // Export management interface
      this._exportManagementInterface();

      // Request service name on our own bus connection
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.dbusServiceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      console.log(`Successfully registered ${this.deviceConfig.serviceType} service ${this.dbusServiceName} on D-Bus`);
      
      // Send ServiceAnnouncement so systemcalc picks up the service for GX Touch
      await this._sendServiceAnnouncement();
    } catch (err) {
      console.error(`Failed to register ${this.deviceConfig.serviceType} service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  async _sendServiceAnnouncement() {
    try {
      // Skip ServiceAnnouncement in test mode
      const isTestMode = typeof globalThis?.describe !== 'undefined' || 
                         process.env.NODE_ENV === 'test' || 
                         this.settings.venusHost === 'test.local';
      
      if (isTestMode) {
        console.log(`Test mode: Skipping ServiceAnnouncement for ${this.dbusServiceName}`);
        return;
      }

      // Send ServiceAnnouncement signal so systemcalc picks up the service
      // This is crucial for GX Touch UI to see the device
      const connectionName = 'SignalK';
      
      await new Promise((resolve, reject) => {
        this.bus.invoke({
          destination: 'com.victronenergy.busitem',
          path: '/',
          interface: 'com.victronenergy.BusItem',
          member: 'ServiceAnnouncement',
          signature: 'siiss',
          body: [
            this.dbusServiceName,                            // s serviceName
            this.vrmInstanceId,                              // i deviceInstance
            this.managementProperties["/ProductId"].value,   // i productId
            this.managementProperties["/ProductName"].value, // s productName
            connectionName                                   // s connection
          ]
        }, (err) => {
          if (err) {
            console.error(`ServiceAnnouncement failed for ${this.dbusServiceName}:`, err);
            reject(err);
          } else {
            console.log(`ServiceAnnouncement sent for ${this.dbusServiceName} (instance: ${this.vrmInstanceId})`);
            resolve();
          }
        });
      });
    } catch (err) {
      console.error(`Failed to send ServiceAnnouncement for ${this.dbusServiceName}:`, err);
      // Don't throw here - service registration should still succeed even if announcement fails
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

    // Export root interface with GetItems and GetValue
    const rootInterface = {
      GetItems: () => {
        const items = [];
        
        // Add management properties
        Object.entries(this.managementProperties).forEach(([path, config]) => {
          items.push([path, [
            ["Value", this._wrapValue(config.type, config.immutable ? config.value : this.deviceData[path])],
            ["Text", this._wrapValue("s", config.text)],
          ]]);
        });
        
        // Add device data properties
        Object.entries(this.deviceData).forEach(([path, value]) => {
          if (this.managementProperties[path]) return;

          const text = this.deviceConfig.pathMappings?.[path] || `${this.deviceConfig.serviceType} property`;
          const type = this.deviceConfig.pathTypes?.[path] || 'd';
          items.push([path, [
            ["Value", this._wrapValue(type, value)],
            ["Text", this._wrapValue('s', text)],
          ]]);
        });

        return items;
      },
      GetValue: () => {
        const items = [];
        
        // Add management properties
        Object.entries(this.managementProperties).forEach(([path, config]) => {
          items.push([path.slice(1), this._wrapValue(config.type, config.immutable ? config.value : this.deviceData[path])]);
        });
        
        // Add device data properties
        Object.entries(this.deviceData).forEach(([path, value]) => {
          if (this.managementProperties[path]) return; 
          const type = this.deviceConfig.pathTypes?.[path] || 'd';
          items.push([path.slice(1), this._wrapValue(type, value)]);
        });

        return this._wrapValue('a{sv}', items);
      },
      SetValue: () => {
        return -1; // Error
      },
      GetText: () => {
        return this.deviceConfig.serviceDescription || `SignalK Virtual ${this.deviceConfig.serviceType} Service`;
      }
    };

    // dbus-native has a bug related to Introspection, which means
    // exporting the root interface will break introspection with
    // 'dbus -y' CLI.
    // https://github.com/sidorares/dbus-native/pull/140
    this.bus.exportInterface(rootInterface, "/", busItemInterface);

    // Export individual property interfaces
    Object.entries(this.managementProperties).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportProperty(path, config) {
    // Set/update the value
    if (!this.managementProperties[path]?.immutable) {
      this.deviceData[path] = config.value;
    }

    // If already exported, done.
    if (path in this.exportedInterfaces) {
      const changes = [];
      changes.push([path, [
        ["Value", this._wrapValue(config.type, config.value)],
        ["Text", this._wrapValue('s', config.text)],
      ]]);

      this.exportedInterfaces[path].emit('ItemsChanged', changes);
      return;
    }

    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", ["value"], ["result"]],
        GetText: ["", "s", [], ["text"]],
      },
      signals: {
        PropertiesChanged: ["a{sv}", ["changes"]],
        ItemsChanged: ["a{sa{sv}}", ["changes"]],
      }
    };

    const propertyInterface = {
      GetValue: () => {
        if (this.managementProperties[path]?.immutable) {
          return this._wrapValue(config.type, config.value);
        }
        const currentValue = this.deviceData[path] || (config.type === 's' ? '' : 0);
        return this._wrapValue(config.type, currentValue);
      },
      SetValue: (val) => {
        if (this.managementProperties[path]?.immutable) {
          return 1; // NOT OK - management properties are read-only (vedbus.py pattern)
        }
        const actualValue = Array.isArray(val) ? val[1] : val;
        
        // Check if value actually changed (vedbus.py pattern)
        if (this.deviceData[path] === actualValue) {
          return 0; // OK - no change needed
        }
        
        this._exportProperty(path, {actualValue, type, text});
        return 0; // OK - value set successfully
      },
      GetText: () => {
        // Handle invalid values like vedbus.py
        if (this.managementProperties[path]?.immutable) {
          return config.text;
        }
        const currentValue = this.deviceData[path];
        if (currentValue === null || currentValue === undefined) {
          return '---'; // vedbus.py pattern for invalid values
        }
        return config.text;
      },
      emit: (signalName, ...signalOutputParams) => {
      },
    };

    this.exportedInterfaces[path] = propertyInterface;
    this.bus.exportInterface(propertyInterface, path, busItemInterface);
  }

  // Public method to update device properties
  updateProperty(path, value, type = 'd', text = `${this.deviceConfig.serviceType} property`) {
    this._exportProperty(path, { value, type, text });
    
    // Emit ItemsChanged signal when values change (like vedbus.py)
    if (this.bus && typeof this.bus.emitSignal === 'function') {
      const changes = [];
      changes.push([path, [
        ["Value", this._wrapValue(type, value)],
        ["Text", this._wrapValue('s', text)],
      ]]);
      
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
        console.error(`Error disconnecting ${this.deviceConfig.serviceType} service ${this.serviceName}:`, err);
      }
      this.bus = null;
    }
    
    // Clear data
    this.deviceData = {};
    this.exportedInterfaces = {};
  }
}
