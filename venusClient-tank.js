import dbusNative from 'dbus-native';
import EventEmitter from 'events';

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.tankData = {};
    this.lastInitAttempt = 0;
    this.tankCounts = {}; // Track how many tanks of each type we have
    this.tankIndex = 0; // For unique tank indexing
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
    this.tankData[path] = config.value;

    const propertyInterface = {
      GetValue: () => {
        return [config.type, this.tankData[path] || (config.type === 's' ? '' : 0)];
      },
      SetValue: (val) => {
        const actualValue = Array.isArray(val) ? val[1] : val;
        this.tankData[path] = actualValue;
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
    if (this.tankData.hasOwnProperty(path)) {
      this.tankData[path] = value;
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
    try {
      // Validate input parameters
      if (value === null || value === undefined) {
        // Skip invalid tank values silently
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
      
      const tankName = this._getTankName(path);
      const index = this.tankIndex++;
      
      if (path.includes('currentLevel')) {
        // Validate and convert level (0-1 to 0-100 percentage)
        if (typeof value === 'number' && !isNaN(value)) {
          const levelPath = `/Tank/${index}/Level`;
          const levelPercent = value * 100;
          this._exportProperty(levelPath, { 
            value: levelPercent, 
            type: 'd', 
            text: `${tankName} level` 
          });
          this.emit('dataUpdated', 'Tank Level', `${tankName}: ${levelPercent.toFixed(1)}%`);
        }
      }
      else if (path.includes('capacity')) {
        // Validate and set capacity
        if (typeof value === 'number' && !isNaN(value)) {
          const capacityPath = `/Tank/${index}/Capacity`;
          this._exportProperty(capacityPath, { 
            value: value, 
            type: 'd', 
            text: `${tankName} capacity` 
          });
          this.emit('dataUpdated', 'Tank Capacity', `${tankName}: ${value}L`);
        }
      }
      else if (path.includes('name')) {
        // Tank name/label
        if (typeof value === 'string') {
          const namePath = `/Tank/${index}/Name`;
          this._exportProperty(namePath, { 
            value: value, 
            type: 's', 
            text: `${tankName} name` 
          });
          this.emit('dataUpdated', 'Tank Name', `${tankName}: ${value}`);
        }
      }
      else {
        // Silently ignore unknown tank paths
        // Silently ignore unknown tank paths
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
      this.tankData = {};
    }
  }
}