/**
 * Device configurations for different Venus OS device types
 * These define the specific properties and behavior for each device type
 */

export const DEVICE_CONFIGS = {
  tank: {
    serviceType: 'tank',
    processName: 'signalk-virtual-device',
    productName: 'SignalK Virtual Tank',
    serviceDescription: 'SignalK Virtual Tank Service',
    additionalProperties: {
      // Tank specific properties
      "/Status": { type: "i", value: 0, text: "Tank status" },
      "/FluidType": { type: "i", value: 0, text: "Fluid Type" },
      "/Level": { type: "d", value: 0.0, text: "Tank level" },
      "/Volume": { type: "d", value: 0.0, text: "Tank volume" },
      "/Capacity": { type: "d", value: 0.0, text: "Tank capacity" },
      "/Remaining": { type: "d", value: 0.0, text: "Tank remaining" },
    },
    pathMappings: {
      '/Level': 'Tank level',
      '/Capacity': 'Tank capacity',
      '/FluidType': 'Fluid type',
      '/Status': 'Tank status',
      '/Name': 'Tank name',
      '/Volume': 'Tank volume',
      '/RawUnit': 'Tank raw unit',
      '/RawValue': 'Tank raw value',
      '/RawValueEmpty': 'Tank raw value',
      '/RawValueFull': 'Tank raw value'
    },
    pathTypes: {
      '/Level': 'd',
      '/Capacity': 'd',
      '/FluidType': 'i',
      '/Status': 'i',
      '/Name': 's',
      '/Volume': 'd',
      '/RawUnit': 's',
      '/RawValue': 'd'
    },
    fluidTypes: {
      // these values are derived from NMEA2K definitions
      'fuel': { 'value': 0, 'name': 'Fuel' },
      'freshWater': { 'value': 1, 'name': 'Fresh Water'},
      'wasteWater': { 'value': 2, 'name': 'Waste Water'},
      'livewell': { 'value': 3, 'name': 'Live Well'},
      'oil': { 'value': 4, 'name': 'Oil'},
      'blackWater': { 'value': 5, 'name': 'Black Water'},
      'gasoline': { 'value': 6, 'name': 'Gasoline'},
      'diesel': { 'value': 7, 'name': 'Diesel'},
      'lpg': { 'value': 8, 'name': 'Liquid Petroleum Gas'},
      'lng': { 'value': 9, 'name': 'Liquid Natural Gas'},
      'hydraulicOil': { 'value': 10, 'name': 'Hydraulic Oil'},
      'rawWater': { 'value': 11, 'name': 'Raw Water'},
    },
  },

  battery: {
    serviceType: 'battery',
    processName: 'signalk-virtual-device',
    productName: 'SignalK Virtual Battery',
    serviceDescription: 'SignalK Virtual Battery Service',
    additionalProperties: {
      // Battery specific properties
      "/Dc/0/Voltage": { type: "d", value: 0.0, text: "Battery voltage" },
      "/Dc/0/Current": { type: "d", value: 0.0, text: "Battery current" },
      "/Dc/0/Power": { type: "d", value: 0.0, text: "Battery power" },
      "/Dc/0/Temperature": { type: "d", value: 0.0, text: "Battery temperature" },
      "/Soc": { type: "d", value: 0.0, text: "State of charge" },
      "/TimeToGo": { type: "i", value: 0, text: "Time to go" },
      "/ConsumedAmphours": { type: "d", value: 0.0, text: "Consumed Ah" },
      "/Capacity": { type: "d", value: 0.0, text: "Battery capacity" },
      "/System/HasBatteryMonitor": { type: "i", value: 1, text: "Has battery monitor" },
      "/Relay/0/State": { type: "i", value: 0, text: "Relay state" },
    },
    pathMappings: {
      '/Dc/0/Voltage': 'Battery voltage',
      '/Dc/0/Current': 'Battery current',
      '/Dc/0/Power': 'Battery power',
      '/Dc/0/Temperature': 'Battery temperature',
      '/Soc': 'State of charge',
      '/TimeToGo': 'Time to go',
      '/ConsumedAmphours': 'Consumed Ah',
      '/Capacity': 'Battery capacity',
      '/System/HasBatteryMonitor': 'Has battery monitor',
      '/Relay/0/State': 'Relay state'
    },
    pathTypes: {
      '/Dc/0/Voltage': 'd',
      '/Dc/0/Current': 'd',
      '/Dc/0/Power': 'd',
      '/Dc/0/Temperature': 'd',
      '/Soc': 'd',
      '/TimeToGo': 'i',
      '/ConsumedAmphours': 'd',
      '/Capacity': 'd',
      '/System/HasBatteryMonitor': 'i',
      '/Relay/0/State': 'i'
    }
  },

  switch: {
    serviceType: 'switch',
    processName: 'signalk-virtual-device',
    productName: 'SignalK Virtual Switch',
    serviceDescription: 'SignalK Virtual Switch Service',
    additionalProperties: {
      // Switch specific properties
      "/Relay/0/State": { type: "i", value: 0, text: "Switch state" },
      "/Switches/0/State": { type: "i", value: 0, text: "Switch state" },
      "/Switches/0/Position": { type: "i", value: 0, text: "Switch position" },
      "/Switches/0/Name": { type: "s", value: "", text: "Switch name" },
      "/DimmingLevel": { type: "i", value: 0, text: "Dimming level" },
    },
    pathMappings: {
      '/Relay/0/State': 'Switch state',
      '/Switches/0/State': 'Switch state',
      '/Switches/0/Position': 'Switch position',
      '/Switches/0/Name': 'Switch name',
      '/DimmingLevel': 'Dimming level'
    },
    pathTypes: {
      '/Relay/0/State': 'i',
      '/Switches/0/State': 'i',
      '/Switches/0/Position': 'i',
      '/Switches/0/Name': 's',
      '/DimmingLevel': 'i'
    }
  },

  environment: {
    serviceType: 'temperature',
    processName: 'signalk-virtual-device',
    productName: 'SignalK Virtual Environment Sensor',
    serviceDescription: 'SignalK Virtual Environment Service',
    additionalProperties: {
      // Environment specific properties
      "/Temperature": { type: "d", value: 0.0, text: "Temperature" },
      "/Humidity": { type: "d", value: 0.0, text: "Humidity" },
      "/Status": { type: "i", value: 0, text: "Status" },
    },
    pathMappings: {
      '/Temperature': 'Temperature',
      '/Humidity': 'Humidity',
      '/Status': 'Status'
    },
    pathTypes: {
      '/Temperature': 'd',
      '/Humidity': 'd',
      '/Status': 'i'
    }
  }
};
