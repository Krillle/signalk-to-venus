import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.batteryData = {};
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
      this._exportBatteryInterface();
      
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

  _exportBatteryInterface() {
    // Export battery-specific D-Bus interfaces using dbus-native
    const batteryPaths = {
      '/Dc/0/Voltage': { value: 0, type: 'd', text: 'Voltage' },
      '/Dc/0/Current': { value: 0, type: 'd', text: 'Current' },
      '/Soc': { value: 0, type: 'd', text: 'State of charge' },
      '/ConsumedAmphours': { value: 0, type: 'd', text: 'Consumed Amphours' },
      '/TimeToGo': { value: 0, type: 'd', text: 'Time to go' },
      '/Dc/0/Temperature': { value: 0, type: 'd', text: 'Temperature' },
      '/Relay/0/State': { value: 0, type: 'd', text: 'Relay state' }
    };

    // Export each battery property
    Object.entries(batteryPaths).forEach(([path, config]) => {
      this._exportProperty(path, config);
    });
  }

  _exportProperty(path, config) {
    // Store initial value
    this.batteryData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.batteryData[path] || 0];
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.batteryData[path] = actualValue;
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
    if (this.batteryData.hasOwnProperty(path)) {
      this.batteryData[path] = value;
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (typeof value !== 'number' || value === null || value === undefined || isNaN(value)) {
        // Skip invalid battery values silently
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
      
      if (path.includes('voltage')) {
        this._updateValue('/Dc/0/Voltage', value);
        this.emit('dataUpdated', 'Battery Voltage', `${value.toFixed(2)}V`);
      }
      else if (path.includes('current')) {
        this._updateValue('/Dc/0/Current', value);
        this.emit('dataUpdated', 'Battery Current', `${value.toFixed(1)}A`);
      }
      else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
        this._updateValue('/Soc', value);
        this.emit('dataUpdated', 'State of Charge', `${Math.round(value * 100)}%`);
      }
      else if (path.includes('consumed') || (path.includes('capacity') && path.includes('consumed'))) {
        this._updateValue('/ConsumedAmphours', value);
        this.emit('dataUpdated', 'Consumed Ah', `${value.toFixed(1)}Ah`);
      }
      else if (path.includes('timeRemaining') || (path.includes('capacity') && path.includes('time'))) {
        if (value !== null) {
          this._updateValue('/TimeToGo', value);
          this.emit('dataUpdated', 'Time Remaining', `${Math.round(value/60)}min`);
        }
      }
      else if (path.includes('relay')) {
        this._updateValue('/Relay/0/State', value);
        this.emit('dataUpdated', 'Relay', value ? 'On' : 'Off');
      }
      else if (path.includes('temperature')) {
        this._updateValue('/Dc/0/Temperature', value);
        this.emit('dataUpdated', 'Battery Temp', `${value.toFixed(1)}°C`);
      }
      else if (path.includes('name')) {
        // Handle battery name/label - not updating D-Bus value, just for logging
        this.emit('dataUpdated', 'Battery Name', value);
      }
      else {
        // Silently ignore unknown battery paths instead of throwing errors
        // Silently ignore unknown battery paths
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
      this.batteryData = {};
    }
  }
}
