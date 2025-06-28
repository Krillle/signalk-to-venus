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
    if (this.interfaces[path]) {
      // Update existing value
      this.interfaces[path]._value = value;
      return;
    }
    
    // Store the interface data
    const interfaceData = {
      _label: label,
      _value: value,
      _type: type
    };
    
    const parent = this; // Capture parent context
    
    // Create interface class following dbus-next examples
    const { Interface, method } = dbus.interface;
    
    class BusItemInterface extends Interface {
      constructor() {
        super('com.victronenergy.BusItem');
        this._value = value;
        this._label = label;
        this._type = type;
      }
      
      GetValue() {
        return new dbus.Variant(this._type, this._value || 0);
      }
      
      SetValue(val) {
        const actualValue = (val && typeof val === 'object' && 'value' in val) ? val.value : val;
        this._value = actualValue;
        interfaceData._value = actualValue;
        parent.emit('valueChanged', path, actualValue);
        return true;
      }
      
      GetText() {
        return this._label || '';
      }
    }

    // Add method decorators
    BusItemInterface.prototype.GetValue = method({ outSignature: 'v' })(BusItemInterface.prototype.GetValue);
    BusItemInterface.prototype.SetValue = method({ inSignature: 'v', outSignature: 'b' })(BusItemInterface.prototype.SetValue);
    BusItemInterface.prototype.GetText = method({ outSignature: 's' })(BusItemInterface.prototype.GetText);

    try {
      const interfaceInstance = new BusItemInterface();
      this.bus.export(`${this.OBJECT_PATH}${path}`, interfaceInstance);
      interfaceData._interface = interfaceInstance;
      this.interfaces[path] = interfaceData;
    } catch (err) {
      console.error(`Failed to export ${path}:`, err);
      throw err;
    }
  }

  _updateValue(path, value) {
    if (this.interfaces[path]) {
      this.interfaces[path]._value = value;
      // Also update the interface instance if it exists
      if (this.interfaces[path]._interface) {
        this.interfaces[path]._interface._value = value;
      }
    }
  }

  async handleSignalKUpdate(path, value) {
    try {
      // Validate input parameters
      if (typeof value !== 'number' || value === null || value === undefined || isNaN(value)) {
        console.debug(`Skipping invalid battery value for ${path}: ${value}`);
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
    
    // Restore original D-Bus address
    if (this.originalAddress) {
      process.env.DBUS_SYSTEM_BUS_ADDRESS = this.originalAddress;
    } else {
      delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    }
  }
}
