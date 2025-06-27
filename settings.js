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
  tankRegex: /^tanks\.(fuel|freshWater|wasteWater|blackWater|lubrication|liveWell|baitWell|gas|ballast)\.\d+\./, 
  temperatureRegex: /^environment\..*\.temperature$|^propulsion\..*\.temperature$/, 
  humidityRegex: /^environment\..*\.(humidity|relativeHumidity)$/, 
  switchRegex: /^electrical\.switches\.[^.]+\.state$/, 
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/
};
