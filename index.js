import { VenusClientFactory } from './venusClientFactory.js';
import { SignalKListener } from './signalkListener.js';
import settings from './settings.js';

const clients = {};
const signalk = new SignalKListener(settings);

signalk.on('update', async (path, value, type) => {
  try {
    const deviceType = VenusClientFactory.identifyDeviceType(path);
    if (!clients[deviceType]) {
      clients[deviceType] = VenusClientFactory.createClient(settings, deviceType);
    }
    await clients[deviceType].handleSignalKUpdate(path, value);
  } catch (err) {
    console.error(`Error handling SignalK path ${path}:`, err);
  }
});

signalk.start();

Object.values(clients).forEach(client => {
  client.on('valueChanged', async (path, value) => {
    try {
      await signalk.sendPutValue(path, value);
    } catch (err) {
      console.error(`Error sending PUT to SignalK for path ${path}:`, err);
    }
  });
});
