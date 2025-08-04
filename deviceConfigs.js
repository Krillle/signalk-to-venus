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
      // NOTE: No default values for tank data properties - they will only be set when real Signal K data arrives
      // This prevents fake data from polluting Venus OS history
      "/Status": { type: "i", value: 0, text: "Tank status" },
      "/FluidType": { type: "i", value: 0, text: "Fluid Type" },
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
      '/Serial': 's',
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
    productName: 'SignalK Virtual Battery Monitor',
    serviceDescription: 'SignalK Virtual Battery Monitor Service',
    additionalProperties: {
      // NOTE: No default values for battery data properties - they will only be set when real Signal K data arrives
      // This prevents fake data from polluting Venus OS history
      "/System/HasBatteryMonitor": { type: "i", value: 1, text: "Has battery monitor" },
      "/System/BatteryService": { type: "i", value: 1, text: "Battery service" },
      "/System/NrOfBatteries": { type: "i", value: 1, text: "Number of batteries" },
      "/Relay/0/State": { type: "i", value: 0, text: "Relay state" },
      "/State": { type: "i", value: 0, text: "Battery state" },
      "/ErrorCode": { type: "i", value: 0, text: "Error code" },
      "/Connected": { type: "i", value: 1, text: "Connected" },
      "/DeviceType": { type: "i", value: 512, text: "Device type" },
      "/Alarms/LowVoltage": { type: "i", value: 0, text: "Low voltage alarm" },
      "/Alarms/HighVoltage": { type: "i", value: 0, text: "High voltage alarm" },
      "/Alarms/LowSoc": { type: "i", value: 0, text: "Low SOC alarm" },
      "/Alarms/HighCurrent": { type: "i", value: 0, text: "High current alarm" },
      "/Alarms/HighTemperature": { type: "i", value: 0, text: "High temperature alarm" },
      "/Alarms/LowTemperature": { type: "i", value: 0, text: "Low temperature alarm" },
      "/Info/BatteryLowVoltage": { type: "i", value: 0, text: "Battery low voltage info" },
      "/Info/MaxChargeCurrent": { type: "i", value: 100, text: "Max charge current" },
      "/Info/MaxDischargeCurrent": { type: "i", value: 100, text: "Max discharge current" },
      "/Info/MaxChargeVoltage": { type: "d", value: 14.4, text: "Max charge voltage" },
      "/Balancer": { type: "i", value: 0, text: "Balancer active" },
      "/Io/AllowToCharge": { type: "i", value: 1, text: "Allow to charge" },
      "/Io/AllowToDischarge": { type: "i", value: 1, text: "Allow to discharge" },
      "/Io/ExternalRelay": { type: "i", value: 0, text: "External relay" },
      
      // History properties for VRM consumption calculations - initialized to 0
      "/History/DischargedEnergy": { type: "d", value: 0, text: "Discharged energy" },
      "/History/ChargedEnergy": { type: "d", value: 0, text: "Charged energy" },
      "/History/TotalAhDrawn": { type: "d", value: 0, text: "Total Ah drawn" },
      "/History/MinimumVoltage": { type: "d", value: 0, text: "Minimum voltage" },
      "/History/MaximumVoltage": { type: "d", value: 0, text: "Maximum voltage" }
    },
    pathMappings: {
      '/Dc/0/Voltage': 'Battery voltage',
      '/Dc/0/Current': 'Battery current',
      '/Dc/0/Power': 'Battery power',
      '/Dc/0/Temperature': 'Battery temperature',
      '/Dc/0/MidVoltage': 'Mid voltage',
      '/Dc/0/MidVoltageDeviation': 'Mid voltage deviation',
      '/Soc': 'State of charge',
      '/TimeToGo': 'Time to go',
      '/ConsumedAmphours': 'Consumed Ah',
      '/Capacity': 'Battery capacity',
      '/System/HasBatteryMonitor': 'Has battery monitor',
      '/System/BatteryService': 'Battery service',
      '/System/NrOfBatteries': 'Number of batteries',
      '/System/MinCellVoltage': 'Minimum cell voltage',
      '/System/MaxCellVoltage': 'Maximum cell voltage',
      '/Relay/0/State': 'Relay state',
      '/State': 'Battery state',
      '/ErrorCode': 'Error code',
      '/Connected': 'Connected',
      '/DeviceType': 'Device type',
      '/Alarms/LowVoltage': 'Low voltage alarm',
      '/Alarms/HighVoltage': 'High voltage alarm',
      '/Alarms/LowSoc': 'Low SOC alarm',
      '/Alarms/HighCurrent': 'High current alarm',
      '/Alarms/HighTemperature': 'High temperature alarm',
      '/Alarms/LowTemperature': 'Low temperature alarm',
      '/Info/BatteryLowVoltage': 'Battery low voltage info',
      '/Info/MaxChargeCurrent': 'Max charge current',
      '/Info/MaxDischargeCurrent': 'Max discharge current',
      '/Info/MaxChargeVoltage': 'Max charge voltage',
      '/History/DischargedEnergy': 'Discharged energy',
      '/History/ChargedEnergy': 'Charged energy',
      '/History/TotalAhDrawn': 'Total Ah drawn',
      '/History/MinimumVoltage': 'Minimum voltage',
      '/History/MaximumVoltage': 'Maximum voltage',
      '/Balancer': 'Balancer active',
      '/Io/AllowToCharge': 'Allow to charge',
      '/Io/AllowToDischarge': 'Allow to discharge',
      '/Io/ExternalRelay': 'External relay'
    },
    pathTypes: {
      '/Serial': 's',
      '/Dc/0/Voltage': 'd',
      '/Dc/0/Current': 'd',
      '/Dc/0/Power': 'd',
      '/Dc/0/Temperature': 'd',
      '/Dc/0/MidVoltage': 'd',
      '/Dc/0/MidVoltageDeviation': 'd',
      '/Soc': 'd',
      '/TimeToGo': 'i',
      '/ConsumedAmphours': 'd',
      '/Capacity': 'd',
      '/System/HasBatteryMonitor': 'i',
      '/System/BatteryService': 'i',
      '/System/NrOfBatteries': 'i',
      '/System/MinCellVoltage': 'd',
      '/System/MaxCellVoltage': 'd',
      '/Relay/0/State': 'i',
      '/State': 'i',
      '/ErrorCode': 'i',
      '/Connected': 'i',
      '/DeviceType': 'i',
      '/Alarms/LowVoltage': 'i',
      '/Alarms/HighVoltage': 'i',
      '/Alarms/LowSoc': 'i',
      '/Alarms/HighCurrent': 'i',
      '/Alarms/HighTemperature': 'i',
      '/Alarms/LowTemperature': 'i',
      '/Info/BatteryLowVoltage': 'i',
      '/Info/MaxChargeCurrent': 'i',
      '/Info/MaxDischargeCurrent': 'i',
      '/Info/MaxChargeVoltage': 'd',
      '/History/DischargedEnergy': 'd',
      '/History/ChargedEnergy': 'd',
      '/History/TotalAhDrawn': 'd',
      '/History/MinimumVoltage': 'd',
      '/History/MaximumVoltage': 'd',
      '/Balancer': 'i',
      '/Io/AllowToCharge': 'i',
      '/Io/AllowToDischarge': 'i',
      '/Io/ExternalRelay': 'i'
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
      '/Serial': 's',
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
      // NOTE: No default values for environment data properties - they will only be set when real Signal K data arrives
      // This prevents fake data from polluting Venus OS history
      "/Status": { type: "i", value: 0, text: "Status" },
    },
    pathMappings: {
      '/Temperature': 'Temperature',
      '/Humidity': 'Humidity',
      '/Status': 'Status'
    },
    pathTypes: {
      '/Serial': 's',
      '/Temperature': 'd',
      '/Humidity': 'd',
      '/Status': 'i'
    }
  }
};
