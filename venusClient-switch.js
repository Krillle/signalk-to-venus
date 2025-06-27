// venusClient-switch.js
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
    this.lastInitAttempt = 0;
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
      throw new Error(`Failed to initialize switch client: ${err.message}`);
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
  }
}
