// venusClient-battery.js
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
      throw new Error(`Failed to initialize battery client: ${err.message}`);
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
    if (!this.bus) await this.init();
    if (path.includes('voltage')) {
      this._export('/Dc/0/Voltage', 'Battery Voltage', value);
      this.emit('dataUpdated', 'Battery Voltage', `${value.toFixed(2)}V`);
    }
    else if (path.includes('current')) {
      this._export('/Dc/0/Current', 'Battery Current', value);
      this.emit('dataUpdated', 'Battery Current', `${value.toFixed(1)}A`);
    }
    else if (path.includes('stateOfCharge')) {
      this._export('/Soc', 'State of Charge', value);
      this.emit('dataUpdated', 'State of Charge', `${Math.round(value * 100)}%`);
    }
    else if (path.includes('consumed')) this._export('/ConsumedAmphours', 'Consumed Ah', value);
    else if (path.includes('timeRemaining')) this._export('/TimeToGo', 'Time Remaining', value);
    else if (path.includes('relay')) this._export('/Relay/0/State', 'Relay', value);
    else if (path.includes('temperature')) this._export('/Dc/0/Temperature', 'Battery Temp', value);
    else if (path.includes('voltage') && path.includes('1')) this._export('/Dc/1/Voltage', 'Starter Voltage', value);
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
