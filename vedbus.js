import dbusNative from 'dbus-native';
import EventEmitter from 'events';

// Get Variant constructor - dbus-native exports it differently
const Variant = dbusNative.Variant || dbusNative.variant || function(type, value) {
  return { type, value };
};

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
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.connectionHealthTimer = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    
    // Generate unique serial number like dbus-serialbattery - combine serviceType and instance
    // const uniqueSerial = `SK_${deviceConfig.serviceType}_${serviceName}_${this.vrmInstanceId}`;
    const uniqueSerial = `SK${deviceConfig.serviceType}${serviceName}${this.vrmInstanceId}`;
    
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

  // Utility function to safely create D-Bus Variants
  _safeVariant(type, value) {
    // Validate inputs to prevent "Missing or invalid serial" errors
    if (value === null || value === undefined) {
      console.warn(`⚠️ Cannot create Variant for null/undefined value (type: ${type})`);
      return null;
    }

    try {
      switch (type) {
        case 'd': // double
          if (typeof value === 'number' && isFinite(value) && !isNaN(value)) {
            // Try different ways to create Variant based on dbus-native version
            if (typeof Variant === 'function') {
              return new Variant('d', value);
            } else {
              return [type, value]; // Fallback to simple array format
            }
          }
          console.warn(`⚠️ Invalid double value for Variant: ${value} (type: ${typeof value})`);
          return null;
          
        case 'i': // integer
          if (typeof value === 'number' && Number.isInteger(value) && isFinite(value)) {
            if (typeof Variant === 'function') {
              return new Variant('i', value);
            } else {
              return [type, value];
            }
          }
          console.warn(`⚠️ Invalid integer value for Variant: ${value} (type: ${typeof value})`);
          return null;
          
        case 's': // string
          if (typeof value === 'string' && value.length > 0) {
            if (typeof Variant === 'function') {
              return new Variant('s', value);
            } else {
              return [type, value];
            }
          }
          console.warn(`⚠️ Invalid string value for Variant: ${value} (type: ${typeof value})`);
          return null;
          
        case 'b': // boolean
          if (typeof value === 'boolean') {
            if (typeof Variant === 'function') {
              return new Variant('b', value);
            } else {
              return [type, value];
            }
          }
          console.warn(`⚠️ Invalid boolean value for Variant: ${value} (type: ${typeof value})`);
          return null;
          
        default:
          console.warn(`⚠️ Unsupported Variant type: ${type}`);
          return null;
      }
    } catch (err) {
      console.error(`❌ Error creating Variant(${type}, ${value}):`, err.message);
      // Fallback to array format if Variant constructor fails
      return [type, value];
    }
  }

  async init() {
    // Create own D-Bus connection and register service
    await this._createBusConnection();
    
    // Get the proper serial number from management properties
    const serialNumber = this.managementProperties["/Serial"].value;
    // Store serial in device data for consistency
    this.deviceData['/Serial'] = serialNumber;
    
    // For BMV devices, immediately export all required properties to prevent "Missing or invalid serial" errors
    if (this.deviceConfig.serviceType === 'battery') {
      
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
      
    } else {
      // For non-BMV devices, just export management properties
      Object.entries(this.managementProperties).forEach(([path, config]) => {
        this._exportProperty(path, config);
      });
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
      this.isConnected = false;
      this._scheduleReconnect();
    });

    this.bus.on('error', (err) => {
      // Handle different types of connection errors
      if (err.code === 'ECONNRESET') {
        // D-Bus connection reset (Venus OS restarted)
      } else if (err.code === 'ECONNREFUSED') {
        // D-Bus connection refused (Venus OS not ready)
      } else if (err.code === 'ENOTFOUND') {
        // D-Bus host not found (DNS issue)
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
          // D-Bus stream reset (Venus OS restarted)
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
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this._attemptReconnect();
    }, delay);
  }

  async _attemptReconnect() {
    try {
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
      
    } catch (err) {
      console.error(`Failed to reconnect ${this.dbusServiceName}:`, err);
      this._scheduleReconnect();
    }
  }

  async _attemptFullReRegistration() {
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
      
    } catch (err) {
      console.error(`Failed to re-register ${this.dbusServiceName}:`, err);
      // Schedule a reconnect attempt
      this._scheduleReconnect();
    }
  }

  async _registerInSettings() {
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
                
                // Update the instance to match the assigned instance
                this.vrmInstanceId = actualInstance;
                this.managementProperties["/DeviceInstance"].value = actualInstance;
              }
            }
          }
        }
      }

    } catch (err) {
      console.error(`Settings registration failed for ${this.deviceConfig.serviceType} ${this.serviceName}:`, err);
    }
  }

  async _registerService() {
    try {
      // Request service name on our own bus connection FIRST
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.dbusServiceName, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Export management interface AFTER service name is registered  
      this._exportManagementInterface();
      
      // Verify that critical properties are properly set
      const serialNumber = this.deviceData['/Serial'] || this.managementProperties['/Serial']?.value;
      const deviceInstance = this.deviceData['/DeviceInstance'] || this.managementProperties['/DeviceInstance']?.value;
      
      if (!serialNumber) {
        console.error(`❌ CRITICAL: No serial number set for ${this.dbusServiceName}! This will cause Venus OS validation failures.`);
      }
      
      // Initialize connection status in device data for heartbeat
      this.deviceData["/Mgmt/Connection"] = 1;
      
      // CRITICAL: Set connected state immediately after successful service registration
      // This ensures data updates will work even if the D-Bus 'connect' event doesn't fire
      // and prevents race conditions during ServiceAnnouncement
      this.isConnected = true;
      
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
        return;
      }

      // Try multiple approaches to announce our service to Venus OS
      let announcementSent = false;
      
      // Method 1: Try com.victronenergy.busitem (standard approach)
      try {
        const busitemExists = await this._checkBusitemService();
        if (busitemExists) {
          await this._sendBusitemAnnouncement();
          announcementSent = true;
        }
      } catch (err) {
        // Busitem announcement failed - try next method
      }
      
      // Method 2: Try com.victronenergy.system (alternative approach)
      if (!announcementSent) {
        try {
          await this._sendSystemAnnouncement();
          announcementSent = true;
        } catch (err) {
          // System announcement failed - try next method
        }
      }
      
      // Method 3: Manual registration with systemcalc
      if (!announcementSent) {
        try {
          await this._registerWithSystemcalc();
          announcementSent = true;
        } catch (err) {
          // Direct systemcalc registration failed
        }
      }
      
      if (!announcementSent) {
        console.warn(`⚠️ All ServiceAnnouncement methods failed for ${this.dbusServiceName} - service may not be visible in Venus OS UI`);
      }
      
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

  async _sendBusitemAnnouncement() {
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
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async _sendSystemAnnouncement() {
    // Try to announce via com.victronenergy.system
    await new Promise((resolve, reject) => {
      this.bus.invoke({
        destination: 'com.victronenergy.system',
        path: '/',
        interface: 'com.victronenergy.BusItem',
        member: 'ServiceAnnouncement',
        signature: 'siiss',
        body: [
          this.dbusServiceName,
          this.vrmInstanceId,
          this.managementProperties["/ProductId"].value,
          this.managementProperties["/ProductName"].value,
          'SignalK'
        ]
      }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async _registerWithSystemcalc() {
    // Try to register directly with systemcalc by calling a method that triggers service discovery
    await new Promise((resolve, reject) => {
      this.bus.invoke({
        destination: 'com.victronenergy.system',
        path: '/ServiceMapping',
        interface: 'com.victronenergy.BusItem',
        member: 'GetValue'
      }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
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

        // Only log GetItems if it's the first time or if there's a significant change in properties count
        if (!this._lastItemsCount || Math.abs(this._lastItemsCount - items.length) > 5) {
          this._lastItemsCount = items.length;
        }
        return items;
      },
      GetValue: () => {
        // Reduce GetValue logging noise - only log occasionally
        if (!this._lastGetValueLog || Date.now() - this._lastGetValueLog > 10000) {
          this._lastGetValueLog = Date.now();
        }
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
      },
      emit: (signalName, ...signalOutputParams) => {
        // Emit signals properly through D-Bus without causing "Missing or invalid serial" errors
        try {
          if (this.bus && this.isConnected && signalName === 'ItemsChanged') {
            // Use the bus invoke method for reliable signal emission
            this.bus.invoke({
              destination: null, // Broadcast signal
              path: '/',
              interface: 'com.victronenergy.BusItem', 
              member: signalName,
              signature: 'a{sa{sv}}',
              body: signalOutputParams
            }, () => {
              // Signal sent successfully - no callback needed
            });
          }
        } catch (err) {
          // Silently handle signal emission errors to prevent service disruption
          console.warn(`Signal emission warning for root interface:`, err.message);
        }
      }
    };

    // dbus-native has a bug related to Introspection, which means
    // exporting the root interface will break introspection with
    // 'dbus -y' CLI.
    // https://github.com/sidorares/dbus-native/pull/140
    this.bus.exportInterface(rootInterface, "/", busItemInterface);
    
    // Store reference to root interface for signal emission
    this.exportedInterfaces['/'] = rootInterface;

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
        // Log only critical property requests to reduce noise
        if (propertyName === 'Serial' || propertyName === 'DeviceInstance' || propertyName === 'Soc') {
          // Reduced logging for critical properties
        }
        
        // Handle requests for properties with or without leading slash
        const pathWithSlash = propertyName.startsWith('/') ? propertyName : `/${propertyName}`;
        const pathWithoutSlash = propertyName.startsWith('/') ? propertyName.substring(1) : propertyName;
        
        // CRITICAL: Always handle Serial requests first - Venus OS validation depends on this
        if (propertyName === 'Serial' || propertyName === '/Serial') {
          const serialValue = `SK${this.vrmInstanceId}`;
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
        // Emit signals properly through D-Bus without causing "Missing or invalid serial" errors
        try {
          if (this.bus && this.isConnected && signalName === 'ItemsChanged') {
            // Use the bus invoke method for reliable signal emission
            this.bus.invoke({
              destination: null, // Broadcast signal
              path: path,
              interface: 'com.victronenergy.BusItem', 
              member: signalName,
              signature: 'a{sa{sv}}',
              body: signalOutputParams
            }, () => {
              // Signal sent successfully - no callback needed
            });
          }
        } catch (err) {
          // Silently handle signal emission errors to prevent service disruption
          console.warn(`Signal emission warning for ${path}:`, err.message);
        }
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
        // Log only critical individual property requests to reduce noise
        if (propertyName === 'Value' && (path.includes('Serial') || path.includes('Soc') || path.includes('Voltage'))) {
          // Reduced logging for critical individual properties
        }
        if (interfaceName === 'com.victronenergy.BusItem' && propertyName === 'Value') {
          return propertyInterface.GetValue();
        } else if (interfaceName === 'com.victronenergy.BusItem' && propertyName === 'Text') {
          return this._wrapValue('s', config.text);
        }
        // CRITICAL: Handle direct Serial property requests on individual property paths
        else if (propertyName === 'Serial' && path === '/Serial') {
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
      console.warn(`⚠️ RACE CONDITION: Cannot update property ${path} - D-Bus not connected for ${this.dbusServiceName} (value: ${value})`);
      return;
    }

    // Check if value actually changed to avoid unnecessary signals
    const oldValue = this.deviceData[path];
    
    // Special preprocessing for critical BMV properties
    if (this.deviceConfig.serviceType === 'battery' && path === '/TimeToGo') {
      // Handle TimeToGo null/undefined/invalid values by converting to -1 (Victron standard for "unknown")
      if (value === null || value === undefined || (typeof value === 'number' && (!isFinite(value) || isNaN(value)))) {
        value = -1;
      }
    }
    
    const valueChanged = oldValue !== value;

    // Update device data first
    this.deviceData[path] = value;
    
    // Ensure the interface is exported
    if (!this.exportedInterfaces[path]) {
      this._exportProperty(path, { value, type, text });
    } else {
      // Update existing exported property
      this._exportProperty(path, { value, type, text });
    }
    
    // Emit D-Bus signals only if value changed and bus is ready
    if (this.bus && this.isConnected && valueChanged) {
      try {
        // CRITICAL: Enhanced validation to prevent "Missing or invalid serial" errors
        if (value === null || value === undefined) {
          return; // Don't emit signals for invalid values
        }
        
        // For numeric values, ensure they're valid numbers
        if (type === 'd' || type === 'i') {
          if (typeof value !== 'number' || !isFinite(value) || isNaN(value)) {
            // Special handling for /TimeToGo - use -1 for "unknown" like Victron does
            if (path === '/TimeToGo') {
              value = -1; // Use Victron's standard "unknown" value
            } else {
              console.warn(`⚠️ Skipping signal emission for ${path} with invalid numeric value: ${value} (type: ${typeof value})`);
              return;
            }
          }
        }
        
        // For string values, ensure they're non-empty
        if (type === 's' && (typeof value !== 'string' || value.length === 0)) {
          console.warn(`⚠️ Skipping signal emission for ${path} with invalid string value: ${value}`);
          return;
        }
        
        // Emit signals for battery services using the enhanced methods
        const isBatteryService = this.deviceConfig.serviceType === 'battery';
        
        if (isBatteryService) {
          // Identify critical battery paths that Venus OS system service monitors
          const isCriticalBatteryPath = path === '/Soc' || path === '/Dc/0/Current' || path === '/Dc/0/Voltage' || 
                                        path === '/ConsumedAmphours' || path === '/TimeToGo' || path === '/Dc/0/Power' ||
                                        path === '/Serial' || path === '/DeviceInstance';
          
          if (isCriticalBatteryPath) {
            // Only log the most critical updates to reduce noise
            if (path === '/Soc' || path === '/Dc/0/Voltage' || path === '/Serial') {
              // Reduced logging for critical BMV paths
            }
            
            // Emit enhanced signals for BMV integration
            this.emitPropertiesChanged(path, {
              Value: value,
              Text: text
            });
            
            this.emitValueChanged(path, value);
          }
        } else {
          // For non-battery services, emit basic signals
          this.emitPropertiesChanged(path, {
            Value: value,
            Text: text
          });
        }
        
      } catch (err) {
        // Handle connection errors gracefully
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.code === 'EPIPE') {
          this.isConnected = false;
          this._scheduleReconnect();
        } else {
          console.error(`❌ Error emitting signals for ${path} on ${this.dbusServiceName}:`, err.message || err);
        }
      }
    } else if (!valueChanged) {
      // Value hasn't changed, no signal needed
    } else {
      // D-Bus connection not available - this is expected during initialization
    }
  }

  emitPropertiesChanged(path, props) {
    if (!this.bus || !this.isConnected) {
      // Connection not ready - this is normal during initialization
      return;
    }

    try {
      // Validate the serial number is available before emitting any signals
      const deviceDataSerial = this.deviceData['/Serial'];
      const managementSerial = this.managementProperties['/Serial']?.value;
      const serialNumber = deviceDataSerial || managementSerial;
      
      if (!serialNumber) {
        console.warn(`❌ Cannot emit signals for ${path}: No serial number available for ${this.dbusServiceName}`);
        return;
      }

      // Use the bus.invoke method to emit signals properly instead of direct message creation
      // This avoids the "Missing or invalid serial" errors from direct message handling
      if (this.exportedInterfaces['/'] && typeof this.exportedInterfaces['/'].emit === 'function') {
        // Emit through the exported interface if available
        const changes = [];
        changes.push([path, [
          ["Value", this._wrapValue(typeof props.Value === 'number' ? 'd' : 's', props.Value)],
          ["Text", this._wrapValue('s', props.Text || path)],
        ]]);
        this.exportedInterfaces['/'].emit('ItemsChanged', changes);
      } else {
        // Fallback to simple property update without complex signal emission
      }

    } catch (err) {
      console.error(`❌ Error emitting PropertiesChanged for ${path}:`, err.message || err);
    }
  }

  emitValueChanged(path, value) {
    if (!this.bus || !this.isConnected) {
      // Connection not ready - this is normal during initialization
      return;
    }

    // Validate value before emitting
    if (value === null || value === undefined) {
      return;
    }

    // Additional validation for numeric values
    if (typeof value === 'number' && (!isFinite(value) || isNaN(value))) {
      console.warn(`⚠️ Skipping ValueChanged signal for ${path}, invalid number:`, value);
      return;
    }

    // Ensure serial number is available
    const deviceDataSerial = this.deviceData['/Serial'];
    const managementSerial = this.managementProperties['/Serial']?.value;
    const serialNumber = deviceDataSerial || managementSerial;
    
    if (!serialNumber) {
      console.warn(`❌ Cannot emit ValueChanged for ${path}: No serial number available for ${this.dbusServiceName}`);
      return;
    }

    // Use the same approach as PropertiesChanged - avoid direct message creation
    try {
      if (this.exportedInterfaces[path] && typeof this.exportedInterfaces[path].emit === 'function') {
        // Emit through the exported interface for this specific path
        this.exportedInterfaces[path].emit('ItemsChanged', [[path, [
          ["Value", this._wrapValue('d', value)],
          ["Text", this._wrapValue('s', `${this.deviceConfig.serviceType} property`)],
        ]]]);
      } else {
        // Just log the value change without complex signal emission
      }
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
  
  // updateValue(path, value) {
  //   // Update device data
  //   this.deviceData[path] = value;
    
  //   // Try to emit PropertiesChanged signal if we have the interface
  //   if (this.exportedInterfaces[path] && this.exportedInterfaces[path].PropertiesChanged) {
  //     try {
  //       this.exportedInterfaces[path].PropertiesChanged([[path, this._wrapValue(
  //         this.deviceConfig.pathTypes?.[path] || 'd', value
  //       )]]);
  //     } catch (error) {
  //       // Silently ignore signal errors
  //     }
  //   }
    
  //   // Also update management properties if it's a management property
  //   if (this.managementProperties[path] && !this.managementProperties[path].immutable) {
  //     this.managementProperties[path].value = value;
  //   }
  // }

  updateValue(path, value) {
    // Update device data
    this.deviceData[path] = value;

    // Ensure the interface is exported before emitting
    if (!this.exportedInterfaces[path]) {
      // Create a config for the property if it doesn't exist
      const type = this.deviceConfig.pathTypes?.[path] || 'd';
      const text = this.deviceConfig.pathMappings?.[path] || `${this.deviceConfig.serviceType} property`;
      this._exportProperty(path, { value, type, text });
    }

    // Emit PropertiesChanged signal if we have the interface
    if (this.exportedInterfaces[path] && this.exportedInterfaces[path].PropertiesChanged) {
      try {
        const wrapped = this._wrapValue(this.deviceConfig.pathTypes?.[path] || 'd', value);
        if (wrapped !== undefined) {
          this.exportedInterfaces[path].PropertiesChanged([[path, wrapped]]);
        }
      } catch (error) {
        console.warn(`❌ Failed to emit signal for ${path}:`, error.message);
      }
    }

    // Update management properties if it's a management property
    if (this.managementProperties[path] && !this.managementProperties[path].immutable) {
      this.managementProperties[path].value = value;
    }
  }

}
