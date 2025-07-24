import { VenusClient } from './venusClient.js';

export function VenusClientFactory(settings, deviceType, logger = null) {
  // All clients now use the unified VenusClient with device-specific configurations
  const supportedTypes = ['batteries', 'tanks', 'environment', 'switches'];
  
  if (!supportedTypes.includes(deviceType)) {
    throw new Error(`Unsupported device type: ${deviceType}. Supported types: ${supportedTypes.join(', ')}`);
  }
  
  // Pass the original device type and logger to VenusClient - it will handle the mapping internally
  const client = new VenusClient(settings, deviceType, logger);
  
  // Set Signal K app reference if logger has getSelfPath method (indicating it's the app object)
  if (logger && logger.getSelfPath) {
    client.setSignalKApp(logger);
  }
  
  return client;
}
