import dbus from 'dbus-next';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.interfaces = {};
    this.lastInitAttempt = 0;
    this.OBJECT_PATH = `/com/victronenergy/virtual/${deviceType}`;
    this.VBUS_SERVICE = `com.victronenergy.virtual.${deviceType}`;
  }

  async init() {
    try {
      // Set the D-Bus address to connect to Venus OS via TCP
      const originalAddress = process.env.DBUS_SYSTEM_BUS_ADDRESS;
      process.env.DBUS_SYSTEM_BUS_ADDRESS = `tcp:host=${this.settings.venusHost},port=78`;
      
      try {
        // Create D-Bus connection using systemBus with TCP address
        this.bus = dbus.systemBus();
        
        // Try to request a name to test the connection
        await this.bus.requestName(this.VBUS_SERVICE);
        this._exportMgmt();
        
      } finally {
        // Restore original D-Bus address
        if (originalAddress) {
          process.env.DBUS_SYSTEM_BUS_ADDRESS = originalAddress;
        } else {
          delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
        }
      }
    } catch (err) {
      // Convert dbus errors to more user-friendly messages
      if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to Venus OS at ${this.settings.venusHost}:78 - ${err.code}`);
      } else if (err.message && err.message.includes('timeout')) {
        throw new Error(`Connection timeout to Venus OS at ${this.settings.venusHost}:78`);
      }
      throw new Error(err.message || err.toString());
    }
  }

  _exportMgmt() {
    const mgmtItems = {
      '/Mgmt/ProcessName': 'signalk-virtual-device',
      '/Mgmt/Connection': `tcp://${this.settings.venusHost}`,
      '/Connected': 1
    };
    for (const path in mgmtItems) {
      this._export(path, path.split('/').pop(), mgmtItems[path], typeof mgmtItems[path] === 'string' ? 's' : 'd');
    }
  }

  _export(path, label, value, type = 'd') {
    if (this.interfaces[path]) return;
    
    const ifaceDesc = {
      name: 'com.victronenergy.BusItem',
      methods: {
        GetValue: ['()', 'v'],
        SetValue: ['v', 'b'],
        GetText: ['()', 's']
      },
      properties: {},
      signals: {
        PropertiesChanged: ['sa{sv}as']
      }
    };

    this.interfaces[path] = dbus.interface(ifaceDesc, {
      _label: label,
      _value: value,
      GetValue() {
        return new dbus.Variant(type, this._value);
      },
      SetValue: (val) => {
        this._value = val.value;
        this.emit('valueChanged', path, val.value);
        return true;
      },
      GetText() {
        return this._label || '';
      }
    });
    
    this.bus.export(`${this.OBJECT_PATH}${path}`, this.interfaces[path]);
  }

  async handleSignalKUpdate(path, value) {
    try {
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
        this._export('/Dc/0/Voltage', 'Battery Voltage', value);
        this.emit('dataUpdated', 'Battery Voltage', `${value.toFixed(2)}V`);
      }
      else if (path.includes('current')) {
        this._export('/Dc/0/Current', 'Battery Current', value);
        this.emit('dataUpdated', 'Battery Current', `${value.toFixed(1)}A`);
      }
      else if (path.includes('stateOfCharge') || (path.includes('capacity') && path.includes('state'))) {
        this._export('/Soc', 'State of Charge', value);
        this.emit('dataUpdated', 'State of Charge', `${Math.round(value * 100)}%`);
      }
      else if (path.includes('consumed') || (path.includes('capacity') && path.includes('consumed'))) {
        this._export('/ConsumedAmphours', 'Consumed Ah', value);
        this.emit('dataUpdated', 'Consumed Ah', `${value.toFixed(1)}Ah`);
      }
      else if (path.includes('timeRemaining') || (path.includes('capacity') && path.includes('time'))) {
        if (value !== null) {
          this._export('/TimeToGo', 'Time Remaining', value);
          this.emit('dataUpdated', 'Time Remaining', `${Math.round(value/60)}min`);
        }
      }
      else if (path.includes('relay')) {
        this._export('/Relay/0/State', 'Relay', value);
        this.emit('dataUpdated', 'Relay', value ? 'On' : 'Off');
      }
      else if (path.includes('temperature')) {
        this._export('/Dc/0/Temperature', 'Battery Temp', value);
        this.emit('dataUpdated', 'Battery Temp', `${value.toFixed(1)}°C`);
      }
      else if (path.includes('name')) {
        // Handle battery name/label
        this._export('/CustomName', 'Battery Name', value);
        this.emit('dataUpdated', 'Battery Name', value);
      }
      else {
        // Silently ignore unknown battery paths instead of throwing errors
        console.debug(`Ignoring unknown battery path: ${path}`);
        return;
      }
      
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async disconnect() {
    if (this.bus) {
      for (const path in this.interfaces) {
        this.bus.unexport(`${this.OBJECT_PATH}${path}`);
      }
      await this.bus.disconnect();
      this.bus = null;
      this.interfaces = {};
    }
  }
}
