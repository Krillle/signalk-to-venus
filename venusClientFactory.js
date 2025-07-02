import { ModernVenusClient } from './venusClient-modern.js';

export function VenusClientFactory(settings, deviceType) {
  // Use the modern implementation with dbus-victron-virtual
  return new ModernVenusClient(settings, deviceType);
}
