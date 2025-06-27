import dbus from 'dbus-next';
import EventEmitter from 'events';
const { Variant, MessageBus } = dbus;
const DBusInterface = dbus.interface;

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
      // Create TCP connection to Venus OS D-Bus with improved error handling
      const net = await import('net');
      const socket = net.default.createConnection(78, this.settings.venusHost);
      
      // Set connection timeout
      socket.setTimeout(5000);
      
      // Wait for socket to connect
      await new Promise((resolve, reject) => {
        socket.on('connect', resolve);
        socket.on('error', (err) => {
          reject(new Error(`Cannot connect to Venus OS at ${this.settings.venusHost}:78 - ${err.code || err.message}`));
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error(`Connection timeout to Venus OS at ${this.settings.venusHost}:78`));
        });
      });

      this.bus = new MessageBus(socket);
      await this.bus.requestName(this.VBUS_SERVICE);
      
      this._exportMgmt();
    } catch (err) {
      throw new Error(err.message);
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

    this.interfaces[path] = DBusInterface(ifaceDesc, {
      _label: label,
      _value: value,
      GetValue() {
        return new Variant(type, this._value);
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
  }
}