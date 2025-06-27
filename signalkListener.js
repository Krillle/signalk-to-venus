import EventEmitter from 'events';
import WebSocket from 'ws';
import fetch from 'node-fetch';

export class SignalKListener extends EventEmitter {
  constructor(settings) {
    super();
    this.skUrl = 'ws://localhost:3000/signalk/v1/stream';
    this.settings = settings;
    this.ws = null; // Store WebSocket connection
  }

  async sendPutValue(path, value, source = 'venus-bridge') {
    const url = `http://localhost:3000/signalk/v1/api/vessels/self/${path}`;
    
    const requestBody = {
      value: value,
      source: source
    };

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const responseData = await response.json();
      console.log(`PUT successful for ${path}:`, responseData);
      return responseData;
    } catch (err) {
      console.error(`PUT request failed for ${path}:`, err);
      throw err;
    }
  }

  /**
   * Send a PUT request via WebSocket delta message
   * This is often more efficient than HTTP PUT for Signal K
   */
  async sendPutValueViaDelta(path, value, source = 'venus-bridge') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not available');
    }

    const requestId = Date.now().toString(); // Simple request ID
    const putDelta = {
      context: 'vessels.self',
      requestId: requestId,
      put: {
        path: path,
        value: value,
        source: source
      }
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`PUT request timeout for ${path}`));
      }, 5000);

      // Listen for the response
      const responseHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            this.ws.off('message', responseHandler);
            
            if (response.state === 'COMPLETED') {
              console.log(`PUT via delta successful for ${path}:`, response);
              resolve(response);
            } else {
              reject(new Error(`PUT failed: ${response.message || 'Unknown error'}`));
            }
          }
        } catch (err) {
          // Ignore parse errors for other messages
        }
      };

      this.ws.on('message', responseHandler);
      this.ws.send(JSON.stringify(putDelta));
    });
  }

  start() {
    this.ws = new WebSocket(this.skUrl);
    this.ws.on('message', data => {
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

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ context: 'vessels.self', subscribe: [{ path: '', period: this.settings.interval || 1000 }] }));
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
