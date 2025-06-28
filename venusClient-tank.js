import dbus from 'dbus-next';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.interfaces = {};
    this.index = 0;
    this.lastInitAttempt = 0;
    this.tankCounts = {}; // Track how many tanks of each type we have
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

  _getTankName(path) {
    // Extract tank type and ID from Signal K path like tanks.fuel.0.currentLevel
    const pathParts = path.split('.');
    if (pathParts.length < 3) return 'Tank';
    
    const tankType = pathParts[1]; // fuel, freshWater, etc.
    const tankId = pathParts[2]; // 0, 1, 2, etc.
    
    // Convert camelCase to proper names
    const typeNames = {
      'fuel': 'Fuel',
      'freshWater': 'Freshwater', 
      'wasteWater': 'Wastewater',
      'blackWater': 'Blackwater',
      'lubrication': 'Lubrication',
      'liveWell': 'Livewell',
      'baitWell': 'Baitwell', 
      'gas': 'Gas',
      'ballast': 'Ballast'
    };
    
    const typeName = typeNames[tankType] || tankType.charAt(0).toUpperCase() + tankType.slice(1);
    
    // Count how many tanks of this type we have seen
    if (!this.tankCounts[tankType]) {
      this.tankCounts[tankType] = [];
    }
    if (!this.tankCounts[tankType].includes(tankId)) {
      this.tankCounts[tankType].push(tankId);
    }
    
    // Only add number if there are multiple tanks of the same type
    if (this.tankCounts[tankType].length > 1) {
      return `${typeName} ${parseInt(tankId) + 1}`;
    } else {
      return typeName;
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
    
    const tankName = this._getTankName(path);
    const index = this.index++;
    
    if (path.includes('currentLevel')) {
      this._export(`/Tank/${index}/Level`, tankName, value);
      this.emit('dataUpdated', 'Tank Level', `${tankName}: ${(value * 100).toFixed(1)}%`);
    } else if (path.includes('capacity')) {
      this._export(`/Tank/${index}/Capacity`, `${tankName} Capacity`, value);
      this.emit('dataUpdated', 'Tank Capacity', `${tankName}: ${value}L`);
    } else if (path.includes('name')) {
      this._export(`/Tank/${index}/Name`, `${tankName} Name`, value, 's');
      this.emit('dataUpdated', 'Tank Name', `${tankName}: ${value}`);
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