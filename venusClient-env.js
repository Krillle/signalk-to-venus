import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.envData = {};
    this.lastInitAttempt = 0;
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
    this.envData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.envData[path] || (config.type === 's' ? '' : 0)];
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.envData[path] = actualValue;
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
    if (this.envData.hasOwnProperty(path)) {
      this.envData[path] = value;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid environment values silently
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
      
      if (path.includes('temperature')) {
        // Temperature in Kelvin (convert from Celsius if needed)
        let tempK = value;
        if (value < 200) {
          // Assume Celsius, convert to Kelvin
          tempK = value + 273.15;
        }
        this._exportProperty('/Temperature', { 
          value: tempK, 
          type: 'd', 
          text: 'Temperature' 
        });
        this.emit('dataUpdated', 'Temperature', `${(tempK - 273.15).toFixed(1)}°C`);
      }
      else if (path.includes('humidity') || path.includes('relativeHumidity')) {
        // Humidity as percentage (0-1 to 0-100)
        const humidityPercent = value > 1 ? value : value * 100;
        this._exportProperty('/Humidity', { 
          value: humidityPercent, 
          type: 'd', 
          text: 'Humidity' 
        });
        this.emit('dataUpdated', 'Humidity', `${humidityPercent.toFixed(1)}%`);
      }
      else if (path.includes('pressure')) {
        // Pressure in Pascals
        this._exportProperty('/Pressure', { 
          value: value, 
          type: 'd', 
          text: 'Atmospheric pressure' 
        });
        this.emit('dataUpdated', 'Pressure', `${(value / 100).toFixed(1)} hPa`);
      }
      else {
        // Silently ignore unknown environment paths (no logging to avoid spam)
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
      this.envData = {};
    }
  }
}