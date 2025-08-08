export default {
  venusHost: 'venus.local',
  interval: 1000,
  batteryCapacity: 800, // Default battery capacity in Ah for time-to-charge calculation
  enabledDevices: {
    batteries: true,
    tanks: true,
    environment: true,
    switches: true
  },
  defaultBatteryCapacity: 800.0, // Default battery capacity in Ah for battery monitor
  batteryRegex: /^electrical\.batteries\.\d+\./, 
  tankRegex: /^tanks\.[^.\/]+\.[^.\/]+\./, 
  temperatureRegex: /^environment\..*\.temperature$|^propulsion\..*\.temperature$/, 
  humidityRegex: /^environment\..*\.(humidity|relativeHumidity)$/, 
  switchRegex: /^electrical\.switches\.[^.]+\.state$/, 
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/,
  
  // Connection resilience settings
  connectionTimeout: 5000, // Connection timeout in milliseconds (default: 5 seconds)
  maxReconnectAttempts: 15, // Maximum reconnection attempts (default: 15)
  reconnectBaseDelay: 1000, // Base delay for exponential backoff (default: 1 second)
  maxReconnectDelay: 60000, // Maximum delay between reconnection attempts (default: 60 seconds)
  
  // Data validation settings
  socValidationEnabled: true, // Enable SOC 0% validation to prevent spurious values
  minDischargeCurrent: 0.5 // Minimum discharge current (A) to accept SOC 0% values
};
