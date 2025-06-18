// venusClient-battery.js
import dbus from 'dbus-next';
import EventEmitter from 'events';
const { Variant } = dbus;

export class VenusClient extends EventEmitter {
  constructor(settings, deviceType) {
    super();
    this.settings = settings;
    this.deviceType = deviceType;
    this.bus = null;
    this.ifaces = {};
    this.OBJECT_PATH = `/com/victronenergy/virtual/${deviceType}`;
    this.VBUS_SERVICE = `com.victronenergy.virtual.${deviceType}`;
  }

  async init() {
    const address = `tcp:host=${this.settings.venusHost},port=78`;
    this.bus = dbus.messageBus({ busAddress: address });
    await this.bus.requestName(this.VBUS_SERVICE);
    this._exportMgmt();
  }

  _exportMgmt() {
    const mgmtItems = {
      '/Mgmt/ProcessName': 'signalk-to-venus',
      '/Mgmt/Connection': `tcp://${this.settings.venusHost}`,
      '/Connected': 1
    };
    for (const path in mgmtItems) {
      this._export(path, path.split('/').pop(), mgmtItems[path], typeof mgmtItems[path] === 'string' ? 's' : 'd');
    }
  }

  _export(path, label, value, type = 'd') {
    if (this.ifaces[path]) return;
    const iface = dbus.interface({
      name: 'com.victronenergy.BusItem',
      methods: {
        GetValue: ['()', 'v'],
        SetValue: ['v', 'b'],
        GetText: ['()', 's']
      },
      signals: { PropertiesChanged: ['sa{sv}as'] }
    }, {
      _label: label,
      _value: value,
      GetValue() { return new Variant(type, this._value); },
      SetValue: (val) => {
        iface._value = val.value;
        this.emit('valueChanged', path, val.value);
        return true;
      },
      GetText() { return iface._label; }
    });
    this.ifaces[path] = iface;
    this.bus.export(`${this.OBJECT_PATH}${path}`, iface);
  }

  async handleSignalKUpdate(path, value) {
    if (!this.bus) await this.init();
    if (path.includes('voltage')) this._export('/Dc/0/Voltage', 'Battery Voltage', value);
    else if (path.includes('current')) this._export('/Dc/0/Current', 'Battery Current', value);
    else if (path.includes('stateOfCharge')) this._export('/Soc', 'State of Charge', value);
    else if (path.includes('consumed')) this._export('/ConsumedAmphours', 'Consumed Ah', value);
    else if (path.includes('timeRemaining')) this._export('/TimeToGo', 'Time Remaining', value);
    else if (path.includes('relay')) this._export('/Relay/0/State', 'Relay', value);
    else if (path.includes('temperature')) this._export('/Dc/0/Temperature', 'Battery Temp', value);
    else if (path.includes('voltage') && path.includes('1')) this._export('/Dc/1/Voltage', 'Starter Voltage', value);
  }
}
