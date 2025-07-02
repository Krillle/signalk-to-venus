import { VenusClient } from './venusClient.js';

export function VenusClientFactory(settings, deviceType) {
  // Use the Venus client implementation with dbus-victron-virtual
  return new VenusClient(settings, deviceType);
}
