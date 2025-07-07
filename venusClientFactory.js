import { VenusClient } from './venusClient-unified.js';

export function VenusClientFactory(settings, deviceType) {
  // All clients now use the unified VenusClient with device-specific configurations
  const supportedTypes = ['batteries', 'tanks', 'environment', 'switches'];
  
  if (!supportedTypes.includes(deviceType)) {
    throw new Error(`Unsupported device type: ${deviceType}. Supported types: ${supportedTypes.join(', ')}`);
  }
  
  // Pass the original device type to VenusClient - it will handle the mapping internally
  return new VenusClient(settings, deviceType);
}
