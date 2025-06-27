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
    
    // Create a simple interface object
    const interfaceObj = {
      _label: label,
      _value: value,
      _type: type,
      _parent: this,
      
      GetValue: function() {
        return new dbus.Variant(this._type, this._value);
      },
      
      SetValue: function(val) {
        this._value = val.value;
        this._parent.emit('valueChanged', path, val.value);
        return true;
      },
      
      GetText: function() {
        return this._label || '';
      }
    };

    this.interfaces[path] = interfaceObj;
    
    try {
      this.bus.export(`${this.OBJECT_PATH}${path}`, this.interfaces[path]);
    } catch (err) {
      // If direct export fails, try creating a proper service interface
      this.interfaces[path] = this.bus.interface('com.victronenergy.BusItem');
      this.interfaces[path]._label = label;
      this.interfaces[path]._value = value;
      this.interfaces[path]._type = type;
      this.interfaces[path]._parent = this;
      
      this.interfaces[path].GetValue = () => new dbus.Variant(type, this.interfaces[path]._value);
      this.interfaces[path].SetValue = (val) => {
        this.interfaces[path]._value = val.value;
        this.emit('valueChanged', path, val.value);
        return true;
      };
      this.interfaces[path].GetText = () => this.interfaces[path]._label || '';
      
      this.bus.export(`${this.OBJECT_PATH}${path}`, this.interfaces[path]);
    }
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
      
      const toCelsius = v => v - 273.15;
      const toPercent = v => v * 100;
      const label = path.split('/').slice(-2).join(' ');
      
      let valueFinal, topic;
      if (path.includes('temperature')) {
        valueFinal = toCelsius(value);
        topic = 'Temperature';
      } else if (path.includes('humidity') || path.includes('relativeHumidity')) {
        valueFinal = toPercent(value);
        topic = 'Humidity';
      } else {
        // Silently ignore unknown environment paths instead of throwing errors
        console.debug(`Ignoring unknown environment path: ${path}`);
        return;
      }
      
      const exportPath = `/Environment/${topic}/${label}`;
      this._export(exportPath, label, valueFinal);
      
      // Emit data updated event for status tracking
      this.emit('dataUpdated', topic, valueFinal);
      
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
    
    // Restore original D-Bus address
    if (this.originalAddress) {
      process.env.DBUS_SYSTEM_BUS_ADDRESS = this.originalAddress;
    } else {
      delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    }
  }
}