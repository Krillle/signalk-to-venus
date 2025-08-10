export default {
  venusHost: 'venus.local',
  interval: 1000,
  enabledDevices: {
    batteries: true,
    tanks: true,
    environment: true,
    switches: true
  },
  
  // Battery Monitor Configuration
  batteryMonitor: {
    batteryCapacity: 800, // Battery capacity in Ah for TTG calculations and monitoring
    directDcDevices: [
      // Solar devices - add your solar panel device paths
      {
        type: 'solar',
        basePath: 'electrical.solar.278',
        currentPath: 'electrical.solar.278.current',
        powerPath: 'electrical.solar.278.panelPower'
      },
      // Alternator devices - add your alternator device paths  
      {
        type: 'alternator',
        basePath: 'electrical.alternator.277',
        currentPath: 'electrical.alternator.277.current',
        powerPath: 'electrical.alternator.277.power'
      }
      // Add more devices as needed:
      // {
      //   type: 'solar',
      //   basePath: 'electrical.solar.279',
      //   currentPath: 'electrical.solar.279.current',
      //   powerPath: 'electrical.solar.279.panelPower'
      // }
    ]
  },
  
  batteryRegex: /^electrical\.batteries\.\d+\./, 
  tankRegex: /^tanks\.[^.\/]+\.[^.\/]+\./, 
  temperatureRegex: /^environment\..*\.temperature$|^propulsion\..*\.temperature$/, 
  humidityRegex: /^environment\..*\.(humidity|relativeHumidity)$/, 
  switchRegex: /^electrical\.switches\.[^.]+\.state$/, 
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/,
  engineRegex: /^propulsion\.[^.]+\.(revolutions|temperature|oilPressure|alternatorVoltage|gear)$/,
  systemRegex: /^(navigation\.(speedOverGround|courseOverGroundTrue)|environment\.depth\.(belowKeel|belowTransducer))$/,
  
  // Connection resilience settings
  connectionTimeout: 5000, // Connection timeout in milliseconds (default: 5 seconds)
  maxReconnectAttempts: 15, // Maximum reconnection attempts (default: 15)
  reconnectBaseDelay: 1000, // Base delay for exponential backoff (default: 1 second)
  maxReconnectDelay: 60000, // Maximum delay between reconnection attempts (default: 60 seconds)
  
  // Data validation settings
  socValidationEnabled: true, // Enable SOC 0% validation to prevent spurious values
  minDischargeCurrent: 0.5 // Minimum discharge current (A) to accept SOC 0% values
};
