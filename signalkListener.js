import EventEmitter from 'events';
import WebSocket from 'ws';
import fetch from 'node-fetch';

export class SignalKListener extends EventEmitter {
  constructor(settings) {
    super();
    this.skUrl = 'ws://localhost:3000/signalk/v1/stream';
    this.settings = settings;
  }

  async sendPutValue(path, value) {
    const url = `http://localhost:3000/signalk/v1/api/vessels/self/${path}`;
    try {
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
    } catch (err) {
      console.error(`PUT request failed for ${path}:`, err);
    }
  }

  start() {
    const ws = new WebSocket(this.skUrl);
    ws.on('message', data => {
      try {
        const json = JSON.parse(data);
        if (json.updates) {
          for (const update of json.updates) {
            for (const val of update.values) {
              if (this._matches(val.path)) {
                this.emit('update', val.path, val.value);
              }
            }
          }
        }
      } catch (err) {
        console.error('WebSocket error:', err);
      }
    });

    ws.on('open', () => {
      ws.send(JSON.stringify({ context: 'vessels.self', subscribe: [{ path: '', period: this.settings.interval || 1000 }] }));
    });
  }

  _matches(path) {
    return (
      (this.settings.batteryRegex && this.settings.batteryRegex.test(path)) ||
      (this.settings.temperatureRegex && this.settings.temperatureRegex.test(path)) ||
      (this.settings.humidityRegex && this.settings.humidityRegex.test(path)) ||
      (this.settings.tankRegex && this.settings.tankRegex.test(path)) ||
      (this.settings.switchRegex && this.settings.switchRegex.test(path)) ||
      (this.settings.dimmerRegex && this.settings.dimmerRegex.test(path))
    );
  }
}
