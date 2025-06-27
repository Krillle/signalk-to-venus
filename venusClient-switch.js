// venusClient-switch.js
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
      this.originalAddress = process.env.DBUS_SYSTEM_BUS_ADDRESS;
      process.env.DBUS_SYSTEM_BUS_ADDRESS = `tcp:host=${this.settings.venusHost},port=78`;
      
      // Create D-Bus connection using systemBus with TCP address
      this.bus = dbus.systemBus();
      
      // Try to request a name to test the connection
      await this.bus.requestName(this.VBUS_SERVICE);
      this._exportMgmt();
      
    } catch (err) {
      // Restore original D-Bus address on error
      if (this.originalAddress) {
        process.env.DBUS_SYSTEM_BUS_ADDRESS = this.originalAddress;
      } else {
        delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
      }
      
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
    
    // Store the interface data first
    const interfaceData = {
      _label: label,
      _value: value,
      _type: type
    };
    
    // Create a D-Bus service object directly using the bus
    const service = this.bus.export(`${this.OBJECT_PATH}${path}`, {
      'com.victronenergy.BusItem': {
        GetValue: {
          signature: 'v',
          method: () => new dbus.Variant(type, interfaceData._value)
        },
        SetValue: {
          signature: 'v',
          returns: 'b',
          method: (val) => {
            interfaceData._value = val.value;
            this.emit('valueChanged', path, val.value);
            return true;
          }
        },
        GetText: {
          signature: 's',
          method: () => interfaceData._label || ''
        }
      }
    });

    interfaceData._service = service;
    this.interfaces[path] = interfaceData;
  }

  _updateValue(path, value) {
    if (this.interfaces[path]) {
      this.interfaces[path]._value = value;
    }
  }

  async handleSignalKUpdate(path, value) {
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
    const id = path.match(/switches\.([^.]+)\./)?.[1] || '0';
    if (path.endsWith('state')) {
      this._export(`/Switches/${id}/State`, `Switch ${id}`, value ? 1 : 0);
      this.emit('dataUpdated', `Switch ${id}`, value ? 'ON' : 'OFF');
    } else if (path.endsWith('dimmingLevel')) {
      this._export(`/Switches/${id}/DimLevel`, `Dimmer ${id}`, value * 100);
      this.emit('dataUpdated', `Dimmer ${id}`, `${Math.round(value * 100)}%`);
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
    
    // Restore original D-Bus address
    if (this.originalAddress) {
      process.env.DBUS_SYSTEM_BUS_ADDRESS = this.originalAddress;
    } else {
      delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    }
  }
}
