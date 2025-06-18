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
    this._export('/Mgmt/ProcessName', 'Process Name', 'signalk-to-venus', 's');
    this._export('/Mgmt/Connection', 'Connection Type', `tcp://${this.settings.venusHost}`, 's');
    this._export('/Connected', 'Connection Status', 1);
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
    const toCelsius = v => v - 273.15;
    const toPercent = v => v * 100;
    const label = path.split('/').slice(-2).join(' ');
    const valueFinal = path.includes('temperature') ? toCelsius(value) : toPercent(value);
    const topic = path.includes('temperature') ? 'Temperature' : 'Humidity';
    this._export(`/Environment/${topic}/${label}`, `${label}`, valueFinal);
  }
}