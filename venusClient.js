import dbus from 'dbus-next';
import EventEmitter from 'events';
const { Variant } = dbus;

export class VenusClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.bus = null;
    this.ifaces = {};
    this.values = {};
    this.OBJECT_PATH = '/com/victronenergy/virtual/signalk-to-venus';
    this.VBUS_SERVICE = 'com.victronenergy.virtual.signalk-to-venus';
    this.tankIndex = 0;
  }

  async init() {
    const address = `tcp:host=${this.options.venusHost},port=78`;
    this.bus = dbus.messageBus({ busAddress: address });
    await this.bus.requestName(this.VBUS_SERVICE);

    const ifaceDesc = {
      name: 'com.victronenergy.BusItem',
      methods: {
        GetValue: ['()', 'v'],
        SetValue: ['v', 'b'],
        GetText: ['()', 's']
      },
      properties: {},
      signals: { PropertiesChanged: ['sa{sv}as'] }
    };

    this.values = {
      '/Mgmt/ProcessName': 'signalk-to-venus',
      '/Mgmt/Connection': `tcp://${this.options.venusHost}`,
      '/Connected': 1,
      '/FirmwareVersion': '1.0',
      '/ProductName': this.options.productName,
      '/Dc/0/Voltage': 0,
      '/Dc/0/Current': 0,
      '/Soc': 0,
      '/TimeToGo': 0,
      '/Dc/1/Voltage': 0
    };

    const labels = {
      '/Mgmt/ProcessName': 'Process Name',
      '/Mgmt/Connection': 'Connection Type',
      '/Connected': 'Connection Status',
      '/FirmwareVersion': 'Firmware Version',
      '/Dc/0/Voltage': 'Battery Voltage',
      '/Dc/0/Current': 'Battery Current',
      '/Soc': 'State of Charge',
      '/TimeToGo': 'Time Remaining',
      '/Dc/1/Voltage': 'Starter Voltage'
    };

    for (const path in this.values) {
      const variantType = typeof this.values[path] === 'string' ? 's' : 'd';
      const iface = {
        _label: labels[path],
        _value: this.values[path],
        GetValue: () => new Variant(variantType, iface._value),
        SetValue: (val) => {
          iface._value = val.value;
          this.emit('valueChanged', path.replace(this.OBJECT_PATH, ''), val.value);
          return true;
        },
        GetText: () => iface._label || ''
      };
      this.ifaces[path] = dbus.interface(ifaceDesc, iface);
      this.bus.export(`${this.OBJECT_PATH}${path}`, this.ifaces[path]);
    }
  }

  _exportIfNeeded(label, text, value, type = 'd') {
    if (this.ifaces[label]) return;
    const iface = dbus.interface({
      name: 'com.victronenergy.BusItem',
      methods: {
        GetValue: ['()', 'v'],
        SetValue: ['v', 'b'],
        GetText: ['()', 's']
      },
      properties: {},
      signals: { PropertiesChanged: ['sa{sv}as'] }
    }, {
      _label: text,
      _value: value,
      GetValue() { return new Variant(type, this._value); },
      SetValue(val) {
        this._value = val.value;
        this.emit('valueChanged', label, val.value);
        return true;
      },
      GetText() { return this._label || ''; }
    });
    this.ifaces[label] = iface;
    this.values[label] = value;
    this.bus.export(`${this.OBJECT_PATH}${label}`, iface);
  }

  async handleSignalKUpdate(path, value) {
    if (!this.bus) await this.init();

    const toCelsius = v => v - 273.15;
    const toPercent = v => v * 100;
    const getId = path => (path.match(/switches\.([^.]+)\./) || [])[1] || '0';

    const tempMap = {
      'outside': 'Outside',
      'inside': 'Inside',
      'inside/engineRoom': 'EngineRoom',
      'inside/mainCabin': 'MainCabin',
      'inside/refrigerator': 'Refrigerator',
      'inside/freezer': 'Freezer',
      'inside/heating': 'Heating',
      'water': 'Water',
      'propulsion/port': 'Port',
      'propulsion/starboard': 'Starboard'
    };

    if (this.options.batteryRegex.test(path)) {
      if (path.includes('voltage')) this._exportIfNeeded('/Dc/0/Voltage', 'Battery Voltage', value);
      else if (path.includes('current')) this._exportIfNeeded('/Dc/0/Current', 'Battery Current', value);
      else if (path.includes('stateOfCharge')) this._exportIfNeeded('/Soc', 'State of Charge', value);
    } else if (this.options.tankRegex.test(path)) {
      if (path.includes('currentLevel')) {
        const index = this.tankIndex++;
        this._exportIfNeeded(`/Tank/${index}/Level`, `Tank ${index}`, value);
      } else if (path.includes('name')) {
        const index = this.tankIndex++;
        this._exportIfNeeded(`/Tank/${index}/Name`, `Tank ${index} Name`, value, 's');
      }
    } else if (this.options.temperatureRegex.test(path)) {
      const cleanPath = path.replace(/^.*?environment\//, '').replace(/\/temperature$/, '');
      const mapped = tempMap[cleanPath];
      if (mapped) this._exportIfNeeded(`/Environment/Temperature/${mapped}`, `${mapped} Temp`, toCelsius(value));
    } else if (this.options.humidityRegex.test(path)) {
      const cleanPath = path.replace(/^.*?environment\//, '').replace(/\/(humidity|relativeHumidity)$/, '');
      const mapped = tempMap[cleanPath];
      if (mapped) this._exportIfNeeded(`/Environment/Humidity/${mapped}`, `${mapped} Humidity`, toPercent(value));
    } else if (this.options.switchRegex.test(path)) {
      const id = getId(path);
      this._exportIfNeeded(`/Switches/${id}/State`, `Switch ${id}`, value ? 1 : 0);
    } else if (this.options.dimmerRegex.test(path)) {
      const id = getId(path);
      this._exportIfNeeded(`/Switches/${id}/DimLevel`, `Dimmer ${id}`, toPercent(value));
    }
  }
}