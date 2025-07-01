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
    // Export management properties using dbus-native
    const mgmtInterface = {
      GetValue: () => {
        return ['d', 1]; // Connected = 1
      },
      SetValue: (val) => {
        return true;
      },
      GetText: () => {
        return ['s', 'Connected'];
      }
    };

    this.bus.exportInterface(mgmtInterface, '/Connected', 'com.victronenergy.BusItem');

    const processNameInterface = {
      GetValue: () => {
        return ['s', 'signalk-virtual-device'];
      },
      SetValue: (val) => {
        return true;
      },
      GetText: () => {
        return ['s', 'Process name'];
      }
    };

    this.bus.exportInterface(processNameInterface, '/Mgmt/ProcessName', 'com.victronenergy.BusItem');

    const connectionInterface = {
      GetValue: () => {
        return ['s', `tcp://${this.settings.venusHost}`];
      },
      SetValue: (val) => {
        return true;
      },
      GetText: () => {
        return ['s', 'Connection'];
      }
    };

    this.bus.exportInterface(connectionInterface, '/Mgmt/Connection', 'com.victronenergy.BusItem');
  }

  _exportProperty(path, config) {
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
        return true;
      },
      GetText: () => {
        return ['s', config.text];
      }
    };

    this.bus.exportInterface(propertyInterface, path, 'com.victronenergy.BusItem');
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
        console.debug(`Skipping invalid switch value for ${path}: ${value}`);
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
        console.debug(`Ignoring unknown switch path: ${path}`);
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
