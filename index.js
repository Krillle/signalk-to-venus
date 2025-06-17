import { VenusClient } from './venusClient.js';
import { SignalKListener } from './signalkListener.js';
import settings from './settings.js';

const venus = new VenusClient(settings);
const signalk = new SignalKListener(settings);

signalk.on('update', async (path, value) => {
  try {
    await venus.handleSignalKUpdate(path, value);
  } catch (err) {
    console.error(`Error handling path ${path}:`, err);
  }
});

venus.onValueChanged = async (path, value) => {
  try {
    await signalk.sendPutValue(path, value);
  } catch (err) {
    console.error(`Error sending PUT to SignalK for path ${path}:`, err);
  }
};

signalk.start();