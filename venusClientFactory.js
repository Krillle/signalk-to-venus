import { VenusClient } from './venusClient-unified.js';

export function VenusClientFactory(settings, deviceType) {
  // All clients now use the unified VenusClient with device-specific configurations
  const supportedTypes = ['batteries', 'tanks', 'environment', 'switches'];
  
  if (!supportedTypes.includes(deviceType)) {
    throw new Error(`Unsupported device type: ${deviceType}. Supported types: ${supportedTypes.join(', ')}`);
  }
  
  // Map plural device types to singular for configuration lookup
  const deviceTypeMap = {
    'batteries': 'battery',
    'tanks': 'tank', 
    'switches': 'switch',
    'environment': 'environment'
  };
  
  const configDeviceType = deviceTypeMap[deviceType] || deviceType;
  return new VenusClient(settings, configDeviceType);
}
