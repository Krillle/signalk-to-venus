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
  batteryRegex: /^electrical\.batteries\.\d+\.(voltage|current|capacity\.stateOfCharge|capacity\.timeRemaining|name)$/, 
  tankRegex: /^tanks\.(fuel|freshWater|wasteWater|blackWater|lubrication|liveWell|baitWell|gas|ballast)\.\d+\.(currentLevel|capacity|name)$/, 
  temperatureRegex: /^environment\.(water|outside|inside(\/(engineRoom|mainCabin|refrigerator|freezer|heating))?)\.temperature$|^propulsion\.(port|starboard)\.temperature$/, 
  humidityRegex: /^environment\.outside\.(humidity|relativeHumidity)$|^environment\.inside(\/(engineRoom|mainCabin|refrigerator|freezer|heating))?\.relativeHumidity$/, 
  switchRegex: /^electrical\.switches\.\d+\.state$/, 
  dimmerRegex: /^electrical\.switches\.\d+\.dimmingLevel$/
};
