export default {
  venusHost: 'venus.local',
  interval: 1000,
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
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/
};
