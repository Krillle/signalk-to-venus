export default {
  venusHost: 'venus.local',
  productName: 'SignalK Virtual Device',
  interval: 1000,
  enabledDevices: {
    batteries: true,
    tanks: true,
    environment: true,
    switches: true
  },
  batteryRegex: /^electrical\.batteries\.\d+\./, 
  tankRegex: /^tanks\.[^.\/]+\.[^.\/]+\./, 
  temperatureRegex: /^environment\..*\.temperature$|^propulsion\..*\.temperature$/, 
  humidityRegex: /^environment\..*\.(humidity|relativeHumidity)$/, 
  pressureRegex: /^environment\..*\.pressure$/, 
  switchRegex: /^electrical\.switches\.[^.]+\.state$/, 
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/
};
