import dbusNative from 'dbus-native';
import EventEmitter from 'events';

const Variant = dbusNative.Variant;

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
    this.dbusServiceName = `com.victronenergy.${deviceConfig.serviceType}.signalkconnector_${serviceName}`;
    this.deviceData = {};
    this.exportedInterfaces = {};
    this.bus = null;
    this.vrmInstanceId = deviceInstance.index;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.connectionHealthTimer = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    
    // Generate unique serial number like dbus-serialbattery - combine serviceType and instance
    const uniqueSerial = `SK_${deviceConfig.serviceType}_${serviceName}_${this.vrmInstanceId}`;
    
    // Management properties that are common to all devices
    this.managementProperties = {
      "/Mgmt/ProcessName": { type: "s", value: deviceConfig.processName, text: "Process name", immutable: true },
      "/Mgmt/ProcessVersion": { type: "s", value: "1.0.12", text: "Process version", immutable: true },
      "/Mgmt/Connection": { type: "i", value: 1, text: "Connected", immutable: true },
      "/DeviceInstance": { type: "i", value: this.vrmInstanceId, text: "Device instance", immutable: true },
      "/ProductId": { type: "i", value: deviceConfig.serviceType === 'battery' ? 0xBA77 : 0, text: "Product ID", immutable: true },
      "/ProductName": { type: "s", value: deviceConfig.productName, text: "Product name", immutable: true },
      "/FirmwareVersion": { type: "s", value: "1.0.12", text: "Firmware Version", immutable: true },
      "/HardwareVersion": { type: "s", value: "1.0", text: "Hardware Version", immutable: true },
      "/Connected": { type: "i", value: 1, text: "Connected", immutable: true },
      "/Serial": { type: "s", value: uniqueSerial, text: "Serial number", immutable: true },
      "/CustomName": { type: "s", value: deviceInstance.name, text: "Custom name" },
      ...deviceConfig.additionalProperties
    };
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();
    
    // Get the proper serial number from management properties
    const serialNumber = this.managementProperties["/Serial"].value;
    // Store serial in device data for consistency
    this.deviceData['/Serial'] = serialNumber;
    
    console.log(`🔧 Initializing serial number for ${this.dbusServiceName}: ${serialNumber}`);
    
    // For BMV devices, immediately export all required properties to prevent "Missing or invalid serial" errors
    if (this.deviceConfig.serviceType === 'battery') {
      console.log(`🔋 Setting up BMV-specific properties for ${this.dbusServiceName}`);
      
      // Export all management properties immediately
      Object.entries(this.managementProperties).forEach(([path, config]) => {
        this._exportProperty(path, config);
      });
      
      // Export minimal BMV properties with default values to prevent validation errors
      const minimalBMVProperties = {
        '/Soc': { value: 50, type: 'd', text: 'State of charge (%)' },
        '/Dc/0/Voltage': { value: 12.6, type: 'd', text: 'DC voltage' },
        '/Dc/0/Current': { value: 0, type: 'd', text: 'DC current' },
        '/Dc/0/Power': { value: 0, type: 'd', text: 'DC power' }
      };
      
      Object.entries(minimalBMVProperties).forEach(([path, config]) => {
        if (!this.deviceData[path]) {
          this.deviceData[path] = config.value;
          this._exportProperty(path, config);
        }
      });
      
      console.log(`✅ BMV properties initialized for ${this.dbusServiceName} with serial: ${serialNumber}`);
    } else {
      // For non-BMV devices, just export management properties
      Object.entries(this.managementProperties).forEach(([path, config]) => {
        this._exportProperty(path, config);
      });
      console.log(`✅ Management properties exported for ${this.deviceConfig.serviceType}: ${serialNumber}`);
    }
    
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
        this.isConnected = true; // CRITICAL: Set connected state for test mode
      } else {
        // Create individual D-Bus connection for this service
        this.bus = dbusNative.createClient({
          host: this.settings.venusHost,
          port: this.settings.port || 78,
          authMethods: ['ANONYMOUS']
        });

        // Set up connection monitoring
        this._setupConnectionMonitoring();

        // Wait for bus to be ready (if it has event support)
        if (typeof this.bus.on === 'function') {
          await new Promise((resolve, reject) => {
            this.bus.on('connect', () => {
              console.log(`D-Bus connected for ${this.dbusServiceName}`);
              this.isConnected = true;
              this.reconnectAttempts = 0;
              resolve();
            });
            this.bus.on('error', (err) => {
              console.error(`D-Bus connection error for ${this.dbusServiceName}:`, err);
              this.isConnected = false;
              reject(err);
            });
          });
        } else {
          this.isConnected = true;
        }
      }
    } catch (err) {
      console.error(`Failed to create D-Bus connection for ${this.deviceConfig.serviceType} service ${this.dbusServiceName}:`, err);
      throw err;
    }
  }

  _setupConnectionMonitoring() {
    if (!this.bus || typeof this.bus.on !== 'function') {
      return;
    }

    // Monitor connection state
    this.bus.on('disconnect', () => {
      console.log(`D-Bus disconnected for ${this.dbusServiceName}`);
      this.isConnected = false;
      this._scheduleReconnect();
    });

    this.bus.on('error', (err) => {
      // Handle different types of connection errors
      if (err.code === 'ECONNRESET') {
        console.log(`D-Bus connection reset for ${this.dbusServiceName} (Venus OS restarted)`);
      } else if (err.code === 'ECONNREFUSED') {
        console.log(`D-Bus connection refused for ${this.dbusServiceName} (Venus OS not ready)`);
      } else if (err.code === 'ENOTFOUND') {
        console.log(`D-Bus host not found for ${this.dbusServiceName} (DNS issue)`);
      } else {
        console.error(`D-Bus error for ${this.dbusServiceName}:`, err);
      }
      this.isConnected = false;
      this._scheduleReconnect();
    });

    // Handle connection stream errors (like ECONNRESET)
    if (this.bus.connection && typeof this.bus.connection.on === 'function') {
      this.bus.connection.on('error', (err) => {
        if (err.code === 'ECONNRESET') {
          console.log(`D-Bus stream reset for ${this.dbusServiceName} (Venus OS restarted)`);
        } else {
          console.error(`D-Bus stream error for ${this.dbusServiceName}:`, err);
        }
        this.isConnected = false;
        this._scheduleReconnect();
      });
    }

    // Monitor connection health with periodic pings
    this._startConnectionHealthCheck();
    
    // Monitor service registration status
    this._startServiceRegistrationCheck();
  }

  _startServiceRegistrationCheck() {
    // Check service registration every 2 minutes
    if (this.serviceRegistrationTimer) {
      clearInterval(this.serviceRegistrationTimer);
    }

    this.serviceRegistrationTimer = setInterval(async () => {
      if (!this.isConnected) {
        return;
      }

      try {
        // Check if our service is still registered by trying to call GetItems on ourselves
        await new Promise((resolve, reject) => {
          this.bus.invoke({
            destination: this.dbusServiceName,
            path: '/',
            interface: 'com.victronenergy.BusItem',
            member: 'GetItems'
          }, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        console.error(`Service registration check failed for ${this.dbusServiceName}:`, err);
        console.log(`Attempting to re-register service ${this.dbusServiceName}`);
        await this._attemptFullReRegistration();
      }
    }, 120000); // Every 2 minutes
  }

  _startConnectionHealthCheck() {
    // Check connection health every 60 seconds
    if (this.connectionHealthTimer) {
      clearInterval(this.connectionHealthTimer);
    }

    this.connectionHealthTimer = setInterval(async () => {
      if (!this.isConnected) {
        return;
      }

      try {
        // Try to ping the D-Bus daemon
        await new Promise((resolve, reject) => {
          this.bus.invoke({
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'Ping'
          }, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        console.error(`Connection health check failed for ${this.dbusServiceName}:`, err);
        this.isConnected = false;
        this._scheduleReconnect();
      }
    }, 60000); // Every 60 seconds
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts reached for ${this.dbusServiceName}`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
    this.reconnectAttempts++;

    console.log(`Scheduling reconnect for ${this.dbusServiceName} in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this._attemptReconnect();
    }, delay);
  }

  async _attemptReconnect() {
    try {
      console.log(`Attempting to reconnect ${this.dbusServiceName}...`);
      
      // Clean up old connection
      if (this.bus) {
        try {
          this.bus.end();
        } catch (err) {
          // Ignore cleanup errors
        }
      }

      // Create new connection
      await this._createBusConnection();
      
      // Re-register service
      await this._registerService();
      
      console.log(`Successfully reconnected ${this.dbusServiceName}`);
      
    } catch (err) {
      console.error(`Failed to reconnect ${this.dbusServiceName}:`, err);
      this._scheduleReconnect();
    }
  }

  async _attemptFullReRegistration() {
    console.log(`Attempting full re-registration for ${this.dbusServiceName}`);
    try {
      // Close existing connection
      if (this.bus) {
        try {
          this.bus.end();
        } catch (err) {
          // Ignore errors during cleanup
        }
      }

      // Clear timers
      this.stopHeartbeat();
      if (this.connectionHealthTimer) {
        clearInterval(this.connectionHealthTimer);
        this.connectionHealthTimer = null;
      }
      if (this.serviceRegistrationTimer) {
        clearInterval(this.serviceRegistrationTimer);
        this.serviceRegistrationTimer = null;
      }

      // Re-initialize everything
      await this._createBusConnection();
      await this._registerInSettings();
      await this._registerService();
      
      console.log(`Successfully re-registered ${this.dbusServiceName} after Venus OS restart`);
      
    } catch (err) {
      console.error(`Failed to re-register ${this.dbusServiceName}:`, err);
      // Schedule a reconnect attempt
      this._scheduleReconnect();
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
      
      // Verify that critical properties are properly set
      const serialNumber = this.deviceData['/Serial'] || this.managementProperties['/Serial']?.value;
      const deviceInstance = this.deviceData['/DeviceInstance'] || this.managementProperties['/DeviceInstance']?.value;
      console.log(`🔧 Service ${this.dbusServiceName} initialized with Serial: ${serialNumber}, DeviceInstance: ${deviceInstance}`);
      
      if (!serialNumber) {
        console.error(`❌ CRITICAL: No serial number set for ${this.dbusServiceName}! This will cause Venus OS validation failures.`);
      } else {
        console.log(`✅ Serial number properly configured for ${this.dbusServiceName}: ${serialNumber}`);
      }
      
      // Initialize connection status in device data for heartbeat
      this.deviceData["/Mgmt/Connection"] = 1;
      
      // Start heartbeat to keep service alive
      this.startHeartbeat();
      
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

      // First check if the busitem service exists
      const busitemExists = await this._checkBusitemService();
      if (!busitemExists) {
        console.log(`ServiceAnnouncement skipped for ${this.dbusServiceName}: com.victronenergy.busitem service not available`);
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

  async _checkBusitemService() {
    try {
      // Check if the busitem service exists by trying to get its introspection
      await new Promise((resolve, reject) => {
        this.bus.invoke({
          destination: 'com.victronenergy.busitem',
          path: '/',
          interface: 'org.freedesktop.DBus.Introspectable',
          member: 'Introspect'
        }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      return true;
    } catch (err) {
      return false;
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
        ItemsChanged: ["a{sa{sv}}", ["changes"]]
      }
    };

    // Export root interface with GetItems and GetValue
    const rootInterface = {
      GetItems: () => {
        const items = [];
        
        // Add management properties (immutable and current values)
        Object.entries(this.managementProperties).forEach(([path, config]) => {
          const currentValue = config.immutable ? config.value : this.deviceData[path];
          items.push([path, [
            ["Value", this._wrapValue(config.type, currentValue)],
            ["Text", this._wrapValue("s", config.text)],
          ]]);
        });
        
        // Add device data properties with proper typing
        Object.entries(this.deviceData).forEach(([path, value]) => {
          if (this.managementProperties[path]) return; // Skip duplicates

          const text = this.deviceConfig.pathMappings?.[path] || `${this.deviceConfig.serviceType} property`;
          const type = this.deviceConfig.pathTypes?.[path] || 'd';
          items.push([path, [
            ["Value", this._wrapValue(type, value)],
            ["Text", this._wrapValue('s', text)],
          ]]);
        });

        // CRITICAL: For battery services, ensure all BMV-required properties are present
        if (this.deviceConfig.serviceType === 'battery') {
          const requiredBMVProperties = ['/Serial', '/Soc', '/Dc/0/Voltage', '/Dc/0/Current', '/DeviceInstance'];
          requiredBMVProperties.forEach(path => {
            if (!items.find(item => item[0] === path)) {
              let value, type, text;
              if (path === '/Serial') {
                value = `SK${this.vrmInstanceId}`;
                type = 's';
                text = 'Serial number';
              } else if (path === '/DeviceInstance') {
                value = this.vrmInstanceId;
                type = 'i';
                text = 'Device instance';
              } else {
                value = 0;
                type = 'd';
                text = 'Battery property';
              }
              items.push([path, [
                ["Value", this._wrapValue(type, value)],
                ["Text", this._wrapValue('s', text)],
              ]]);
            }
          });
        }

        console.log(`📋 GetItems for ${this.dbusServiceName}: ${items.length} properties available`);
        return items;
      },
      GetValue: () => {
        console.log(`🔍 D-Bus BusItem.GetValue request for ${this.dbusServiceName}`);
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

    // Export standard D-Bus Properties interface for PropertiesChanged signals
    const dbusPropertiesInterface = {
      name: "org.freedesktop.DBus.Properties",
      methods: {
        Get: ["ss", "v", ["interface_name", "property_name"], ["value"]],
        GetAll: ["s", "a{sv}", ["interface_name"], ["properties"]],
        Set: ["ssv", "", ["interface_name", "property_name", "value"], []]
      },
      signals: {
        PropertiesChanged: ["sa{sv}as", ["interface_name", "changed_properties", "invalidated_properties"]]
      }
    };

    const dbusPropertiesImpl = {
      Get: (interfaceName, propertyName) => {
        // Log ALL property requests to debug what Venus OS is looking for
        console.log(`🔍 D-Bus Properties.Get request: interface=${interfaceName}, property=${propertyName} for ${this.dbusServiceName}`);
        
        // Handle requests for properties with or without leading slash
        const pathWithSlash = propertyName.startsWith('/') ? propertyName : `/${propertyName}`;
        const pathWithoutSlash = propertyName.startsWith('/') ? propertyName.substring(1) : propertyName;
        
        // CRITICAL: Always handle Serial requests first - Venus OS validation depends on this
        if (propertyName === 'Serial' || propertyName === '/Serial') {
          const serialValue = `SK${this.vrmInstanceId}`;
          console.log(`🔧 D-Bus Properties.Get Serial request for ${this.dbusServiceName}: ${serialValue}`);
          return this._wrapValue('s', serialValue);
        }
        
        // Check management properties first (they take precedence)
        if (this.managementProperties[pathWithSlash]) {
          const config = this.managementProperties[pathWithSlash];
          const value = config.immutable ? config.value : this.deviceData[pathWithSlash];
          return this._wrapValue(config.type, value);
        }
        
        // Check device data
        if (this.deviceData[pathWithSlash] !== undefined) {
          const type = this.deviceConfig.pathTypes?.[pathWithSlash] || 'd';
          return this._wrapValue(type, this.deviceData[pathWithSlash]);
        }
        
        if (this.deviceData[pathWithoutSlash] !== undefined) {
          const type = this.deviceConfig.pathTypes?.[pathWithoutSlash] || 'd';
          return this._wrapValue(type, this.deviceData[pathWithoutSlash]);
        }
        
        // CRITICAL: Special handling for other key properties Venus OS looks for
        if (propertyName === 'DeviceInstance' || propertyName === '/DeviceInstance') {
          return this._wrapValue('i', this.vrmInstanceId);
        } else if (this.deviceConfig.serviceType === 'battery') {
          // For unknown battery properties, return sensible defaults
          if (propertyName.includes('Voltage') || propertyName.includes('Current') || propertyName.includes('Soc')) {
            return this._wrapValue('d', 0);
          }
        }
        
        console.log(`⚠️ Property ${propertyName} not found in ${this.dbusServiceName}`);
        return this._wrapValue('s', '');
      },
      GetAll: (interfaceName) => {
        // Return all properties for the interface
        const properties = {};
        
        // CRITICAL: Always include Serial first for Venus OS validation
        properties['Serial'] = this._wrapValue('s', `SK${this.vrmInstanceId}`);
        properties['DeviceInstance'] = this._wrapValue('i', this.vrmInstanceId);
        
        // Add management properties
        Object.entries(this.managementProperties).forEach(([path, config]) => {
          const propName = path.startsWith('/') ? path.substring(1) : path;
          if (propName && propName !== 'Serial' && propName !== 'DeviceInstance') { // Avoid duplicates
            const value = config.immutable ? config.value : this.deviceData[path];
            properties[propName] = this._wrapValue(config.type, value);
          }
        });
        
        // Add device data properties
        Object.entries(this.deviceData).forEach(([path, value]) => {
          if (this.managementProperties[path]) return; // Skip management properties
          const type = this.deviceConfig.pathTypes?.[path] || 'd';
          const propName = path.startsWith('/') ? path.substring(1) : path;
          if (propName && propName !== 'Serial' && propName !== 'DeviceInstance') { // Avoid duplicates
            properties[propName] = this._wrapValue(type, value);
          }
        });
        
        console.log(`🔧 D-Bus Properties.GetAll for ${this.dbusServiceName}: ${Object.keys(properties).length} properties`);
        return properties;
      },
      Set: (interfaceName, propertyName, value) => {
        // Allow setting properties via D-Bus (only non-immutable ones)
        const pathWithSlash = propertyName.startsWith('/') ? propertyName : `/${propertyName}`;
        
        if (this.managementProperties[pathWithSlash]?.immutable) {
          return; // Don't allow setting immutable properties
        }
        
        const actualValue = Array.isArray(value) ? value[1] : value;
        this.deviceData[pathWithSlash] = actualValue;
      }
    };

    // Export the standard D-Bus Properties interface on root path
    this.bus.exportInterface(dbusPropertiesImpl, "/", dbusPropertiesInterface);

    // Export individual property interfaces
    Object.entries(this.managementProperties).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportProperty(path, config) {
    // Set/update the value in deviceData for both mutable and immutable properties
    this.deviceData[path] = config.value;

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
        ItemsChanged: ["a{sa{sv}}", ["changes"]],
      }
    };

    const propertyInterface = {
      GetValue: () => {
        // Always get the current value from deviceData, whether immutable or not
        const currentValue = this.deviceData[path];
        if (currentValue !== undefined) {
          return this._wrapValue(config.type, currentValue);
        }
        // Fallback to config value if not in deviceData
        return this._wrapValue(config.type, config.value);
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
        
        this._exportProperty(path, {value: actualValue, type: config.type, text: config.text});
        return 0; // OK - value set successfully
      },
      GetText: () => {
        // Always return the configured text for the property
        return config.text || `${path} property`;
      },
      emit: (signalName, ...signalOutputParams) => {
      },
    };

    this.exportedInterfaces[path] = propertyInterface;
    this.bus.exportInterface(propertyInterface, path, busItemInterface);

    // Also export the standard D-Bus Properties interface for this property
    const dbusPropertiesInterface = {
      name: "org.freedesktop.DBus.Properties",
      methods: {
        Get: ["ss", "v", ["interface_name", "property_name"], ["value"]],
        GetAll: ["s", "a{sv}", ["interface_name"], ["properties"]],
        Set: ["ssv", "", ["interface_name", "property_name", "value"], []]
      },
      signals: {
        PropertiesChanged: ["sa{sv}as", ["interface_name", "changed_properties", "invalidated_properties"]]
      }
    };

    const dbusPropertiesImpl = {
      Get: (interfaceName, propertyName) => {
        console.log(`🔍 Individual property D-Bus Get: path=${path}, interface=${interfaceName}, property=${propertyName}`);
        if (interfaceName === 'com.victronenergy.BusItem' && propertyName === 'Value') {
          return propertyInterface.GetValue();
        } else if (interfaceName === 'com.victronenergy.BusItem' && propertyName === 'Text') {
          return this._wrapValue('s', config.text);
        }
        // CRITICAL: Handle direct Serial property requests on individual property paths
        else if (propertyName === 'Serial' && path === '/Serial') {
          console.log(`🔧 Serial property direct access on ${path}: SK${this.vrmInstanceId}`);
          return this._wrapValue('s', `SK${this.vrmInstanceId}`);
        }
        return this._wrapValue('s', '');
      },
      GetAll: (interfaceName) => {
        if (interfaceName === 'com.victronenergy.BusItem') {
          const result = {
            'Value': propertyInterface.GetValue(),
            'Text': this._wrapValue('s', config.text)
          };
          // Special handling for Serial property path
          if (path === '/Serial') {
            result['Serial'] = this._wrapValue('s', `SK${this.vrmInstanceId}`);
          }
          return result;
        }
        return {};
      },
      Set: (interfaceName, propertyName, value) => {
        if (interfaceName === 'com.victronenergy.BusItem' && propertyName === 'Value') {
          return propertyInterface.SetValue(value);
        }
      }
    };

    // Export Properties interface for this property path
    this.bus.exportInterface(dbusPropertiesImpl, path, dbusPropertiesInterface);
  }

  // Public method to update device properties
  updateProperty(path, value, type = 'd', text = `${this.deviceConfig.serviceType} property`) {
    if (!this.isConnected) {
      console.warn(`Cannot update property ${path} - D-Bus not connected for ${this.dbusServiceName}`);
      return;
    }

    // Check if value actually changed to avoid unnecessary signals
    const oldValue = this.deviceData[path];
    const valueChanged = oldValue !== value;

    this._exportProperty(path, { value, type, text });
    
    // Emit D-Bus signals based on device type and criticality of the path
    const isBatteryService = this.deviceConfig.serviceType === 'battery';
    
    if (this.bus && this.bus.connection && this.bus.connection.message && valueChanged) {
      try {
        // Always emit basic ItemsChanged signal for value changes
        const changes = [];
        changes.push([path, [
          ["Value", this._wrapValue(type, value)],
          ["Text", this._wrapValue('s', text)],
        ]]);
        
        const itemsChangedMsg = this.bus.connection.message({
          type: 'signal',
          path: '/',
          interface: 'com.victronenergy.BusItem',
          member: 'ItemsChanged',
          signature: 'a{sa{sv}}',
          body: [changes],
          destination: null,
          sender: this.dbusServiceName
        });
        this.bus.connection.send(itemsChangedMsg);
        
        // For battery services, emit additional signals for BMV integration
        if (isBatteryService) {
          // Identify critical battery paths that Venus OS system service monitors
          const isCriticalBatteryPath = path === '/Soc' || path === '/Dc/0/Current' || path === '/Dc/0/Voltage' || 
                                        path === '/ConsumedAmphours' || path === '/TimeToGo' || path === '/Dc/0/Power' ||
                                        path === '/Serial' || path === '/DeviceInstance';
          
          if (isCriticalBatteryPath) {
            // Re-enabled with proper validation: Emit signals for Venus OS systemcalc integration
            console.log(`🔋 BMV critical property updated: ${path} = ${value}`);
            
            // Only emit signals for valid values (non-null, non-undefined)
            if (value !== null && value !== undefined && !isNaN(value)) {
              this.emitPropertiesChanged(path, {
                Value: value,
                Text: text
              });
              
              this.emitValueChanged(path, value);
            } else {
              console.log(`� Skipping signal emission for ${path} with invalid value: ${value}`);
            }
          } else {
            console.log(`📝 Battery property updated: ${path} = ${value}`);
          }
        } else {
          // For non-battery services (tanks, environment), basic ItemsChanged is sufficient
          console.log(`📝 ${this.deviceConfig.serviceType} property updated: ${path} = ${value}`);
        }
        
      } catch (err) {
        // Handle connection errors gracefully
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
          console.log(`D-Bus connection lost while updating ${path} for ${this.dbusServiceName} - will reconnect`);
          this.isConnected = false;
          this._scheduleReconnect();
        } else {
          console.error(`❌ Error emitting signals for ${path} on ${this.dbusServiceName}:`, err.message || err);
        }
      }
    } else if (!valueChanged) {
      // Value hasn't changed, no signal needed
      console.log(`� Property ${path} unchanged: ${value}`);
    } else {
      // D-Bus connection not available - this is expected during initialization
      console.log(`D-Bus not ready for ${this.dbusServiceName}, storing ${path} = ${value} for later emission`);
    }
  }

  emitPropertiesChanged(path, props) {
    if (!this.bus || !this.isConnected || !this.bus.connection || !this.bus.connection.message) {
      // Connection not ready - this is normal during initialization
      return;
    }

    try {
      // Create D-Bus compatible signal data with proper Venus OS format
      const changes = {};
      for (const key in props) {
        const val = props[key];
        
        // CRITICAL: Validate values before creating Variants to prevent "Missing or invalid serial" errors
        if (val === null || val === undefined) {
          console.warn(`❗ Skipping ${key} with null/undefined value for ${path}`);
          continue; // Skip null/undefined values instead of creating invalid Variants
        }
        
        if (key === 'Value' && typeof val === 'number' && !isNaN(val)) {
          changes[key] = new Variant('d', val);
        } else if (key === 'Text' && typeof val === 'string') {
          changes[key] = new Variant('s', val);
        } else if (typeof val === 'boolean') {
          changes[key] = new Variant('b', val);
        } else if (typeof val === 'number' && Number.isInteger(val) && !isNaN(val)) {
          changes[key] = new Variant('i', val);
        } else {
          console.warn(`❗ Unsupported property type for ${key}=${val} on ${path}`);
          continue; // Skip unsupported types
        }
      }

      // Only emit if we have valid changes
      if (Object.keys(changes).length === 0) {
        console.log(`🔧 No valid properties to emit for ${path}, skipping signal`);
        return;
      }

      // Emit PropertiesChanged signal on the specific property path
      const propertyMsg = this.bus.connection.message({
        type: 'signal',
        path: path,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'PropertiesChanged',
        signature: 'sa{sv}as',
        body: [
          'com.victronenergy.BusItem',
          changes,
          []
        ],
        destination: null,
        sender: this.dbusServiceName
      });
      this.bus.connection.send(propertyMsg);
      
      // CRITICAL: Also emit on root path for Venus OS systemcalc discovery
      // This is what makes the difference between a tank sensor and BMV
      const propertyName = path.startsWith('/') ? path.substring(1) : path;
      if (changes.Value) {
        const rootMsg = this.bus.connection.message({
          type: 'signal',
          path: '/',
          interface: 'org.freedesktop.DBus.Properties',
          member: 'PropertiesChanged',
          signature: 'sa{sv}as',
          body: [
            'com.victronenergy.BusItem',
            { [propertyName]: changes.Value },
            []
          ],
          destination: null,
          sender: this.dbusServiceName
        });
        this.bus.connection.send(rootMsg);
      }
    } catch (err) {
      console.error(`❌ Error emitting PropertiesChanged for ${path}:`, err.message || err);
    }
  }

  emitValueChanged(path, value) {
    if (!this.bus || !this.isConnected || !this.bus.connection || !this.bus.connection.message) {
      // Connection not ready - this is normal during initialization
      return;
    }

    // CRITICAL: Validate value before creating Variant to prevent "Missing or invalid serial" errors
    if (value === null || value === undefined) {
      console.log(`🔧 Skipping ValueChanged for ${path} with null/undefined value`);
      return;
    }

    try {
      // Create properly typed variant for Venus OS consumption
      let typedValue;
      if (typeof value === 'number' && !isNaN(value)) {
        // Use double precision for all numbers to match Venus OS expectations
        typedValue = new Variant('d', value);
      } else if (typeof value === 'string') {
        typedValue = new Variant('s', value);
      } else if (typeof value === 'boolean') {
        typedValue = new Variant('b', value);
      } else {
        console.warn(`❗ Unsupported value type for ${path}: ${typeof value}, value: ${value}`);
        return; // Don't emit for unsupported types
      }

      // Emit ValueChanged signal on the property path (for direct property monitoring)
      const propertyMsg = this.bus.connection.message({
        type: 'signal',
        path: path,
        interface: 'com.victronenergy.BusItem',
        member: 'ValueChanged',
        signature: 'v',
        body: [typedValue],
        destination: null,
        sender: this.dbusServiceName
      });
      this.bus.connection.send(propertyMsg);
      
      // CRITICAL: Emit on root path for Venus OS systemcalc integration
      // This ensures proper BMV recognition by system services
      const rootValueMsg = this.bus.connection.message({
        type: 'signal',
        path: '/',
        interface: 'com.victronenergy.BusItem',
        member: 'ValueChanged',
        signature: 'sv',
        body: [
          path.startsWith('/') ? path.substring(1) : path,
          typedValue
        ],
        destination: null,
        sender: this.dbusServiceName
      });
      this.bus.connection.send(rootValueMsg);
    } catch (err) {
      console.error(`❌ Error emitting ValueChanged for ${path}:`, err.message || err);
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
    // Stop all timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.connectionHealthTimer) {
      clearInterval(this.connectionHealthTimer);
      this.connectionHealthTimer = null;
    }
    
    if (this.serviceRegistrationTimer) {
      clearInterval(this.serviceRegistrationTimer);
      this.serviceRegistrationTimer = null;
    }
    
    this.isConnected = false;
    
    // Close the individual D-Bus connection
    if (this.bus) {
      try {
        // Try different methods to close the connection
        if (typeof this.bus.end === 'function') {
          this.bus.end();
        } else if (typeof this.bus.close === 'function') {
          this.bus.close();
        } else if (typeof this.bus.disconnect === 'function') {
          this.bus.disconnect();
        } else if (typeof this.bus.connection && typeof this.bus.connection.end === 'function') {
          this.bus.connection.end();
        }
        // If none of the above work, just set to null
      } catch (err) {
        console.error(`Error disconnecting ${this.deviceConfig.serviceType} service ${this.serviceName}:`, err);
      }
      this.bus = null;
    }
    
    // Clear data
    this.deviceData = {};
    this.exportedInterfaces = {};
  }
  
  startHeartbeat() {
    // Stop any existing heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    // Start new heartbeat timer
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isConnected) {
        return;
      }
      
      try {
        // Try to update the connection property
        this.updateValue("/Mgmt/Connection", 1);
        
        // Also try a simple D-Bus operation to verify connection
        await new Promise((resolve, reject) => {
          this.bus.invoke({
            destination: 'org.freedesktop.DBus',
            path: '/org/freedesktop/DBus',
            interface: 'org.freedesktop.DBus',
            member: 'GetId'
          }, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        console.error(`Heartbeat failed for ${this.dbusServiceName}:`, err);
        this.isConnected = false;
        this._scheduleReconnect();
      }
    }, 30000); // Every 30 seconds
  }
  
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  
  updateValue(path, value) {
    // Update device data
    this.deviceData[path] = value;
    
    // Try to emit PropertiesChanged signal if we have the interface
    if (this.exportedInterfaces[path] && this.exportedInterfaces[path].PropertiesChanged) {
      try {
        this.exportedInterfaces[path].PropertiesChanged([[path, this._wrapValue(
          this.deviceConfig.pathTypes?.[path] || 'd', value
        )]]);
      } catch (error) {
        // Silently ignore signal errors
      }
    }
    
    // Also update management properties if it's a management property
    if (this.managementProperties[path] && !this.managementProperties[path].immutable) {
      this.managementProperties[path].value = value;
    }
  }
}
