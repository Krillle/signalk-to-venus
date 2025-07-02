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
    this.VBUS_SERVICE = `com.victronenergy.virtual.${deviceType}`;
  }

  async init() {
    try {
      // Create D-Bus connection using dbus-native with anonymous authentication
      this.bus = dbusNative.createClient({
        host: this.settings.venusHost,
        port: 78,
        authMethods: ['ANONYMOUS']
      });
      
      // Request service name
      await new Promise((resolve, reject) => {
        this.bus.requestName(this.VBUS_SERVICE, 0, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      this._exportMgmt();
      
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
    // Define the BusItem interface descriptor for dbus-native
    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", [], []],
        GetText: ["", "s", [], ["text"]],
      },
    };

    // Export management properties using dbus-native with proper interface descriptors
    const mgmtInterface = {
      GetValue: () => {
        return ['i', 1]; // Connected = 1 (integer, not double)
      },
      SetValue: (val) => {
        return 0; // Success
      },
      GetText: () => {
        return 'Connected'; // Native string return
      }
    };

    this.bus.exportInterface(mgmtInterface, '/Mgmt/Connection', busItemInterface);

    // Product Name - Required for Venus OS recognition
    const productNameInterface = {
      GetValue: () => {
        return ['s', 'SignalK Virtual Switch'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    this.bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);

    // Device Instance - Required for unique identification
    const deviceInstanceInterface = {
      GetValue: () => {
        return ['u', 102]; // Unsigned integer for device instance
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    this.bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);

    // Custom Name
    const customNameInterface = {
      GetValue: () => {
        return ['s', 'SignalK Switch'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Custom name';
      }
    };

    this.bus.exportInterface(customNameInterface, '/CustomName', busItemInterface);

    // Process Name and Version - Required for VRM registration
    const processNameInterface = {
      GetValue: () => {
        return ['s', 'signalk-switch-sensor'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process name';
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', busItemInterface);

    const processVersionInterface = {
      GetValue: () => {
        return ['s', '1.0.12'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Process version';
      }
    };

    this.bus.exportInterface(processVersionInterface, '/Mgmt/ProcessVersion', busItemInterface);
  }

  _exportProperty(path, config) {
    // Define the BusItem interface descriptor for dbus-native
    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", [], []],
        GetText: ["", "s", [], ["text"]],
      },
    };

    // Store initial value
    this.switchData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.switchData[path] || (config.type === 's' ? '' : 0)];
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
      
      const switchName = this._getSwitchName(path);
      const index = this.switchIndex++;
      
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
      this.switchData = {};
    }
  }
}
