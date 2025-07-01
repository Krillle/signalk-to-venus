#!/usr/bin/env node

// Test script to simulate device discovery without requiring a full Signal K server
import settings from './settings.js';

console.log('🔍 Testing Signal K to Venus OS Plugin Device Discovery\n');

// Test data that would typically come from Signal K
const testSignalKData = [
  { path: 'electrical.batteries.0.voltage', value: 12.4 },
  { path: 'electrical.batteries.0.current', value: -5.2 },
  { path: 'electrical.batteries.0.stateOfCharge', value: 0.85 },
  { path: 'electrical.batteries.1.voltage', value: 12.6 },
  { path: 'tanks.fuel.0.currentLevel', value: 0.75 },
  { path: 'tanks.freshWater.0.currentLevel', value: 0.60 },
  { path: 'tanks.blackWater.0.currentLevel', value: 0.15 },
  { path: 'environment.inside.temperature', value: 295.15 },
  { path: 'environment.outside.temperature', value: 288.15 },
  { path: 'environment.inside.relativeHumidity', value: 0.45 },
  { path: 'electrical.switches.navigation.state', value: true },
  { path: 'electrical.switches.cabin.state', value: false },
  { path: 'electrical.switches.masthead.dimmingLevel', value: 0.8 }
];

console.log('Sample Signal K data paths:');
testSignalKData.forEach((data, index) => {
  console.log(`  ${index + 1}. ${data.path} = ${data.value}`);
});

console.log('\n📊 Testing regex patterns:');

// Test each regex pattern
const deviceTypes = {
  'Battery': settings.batteryRegex,
  'Tank': settings.tankRegex, 
  'Temperature': settings.temperatureRegex,
  'Humidity': settings.humidityRegex,
  'Switch': settings.switchRegex,
  'Dimmer': settings.dimmerRegex
};

Object.entries(deviceTypes).forEach(([name, regex]) => {
  console.log(`\n${name} regex: ${regex}`);
  const matches = testSignalKData.filter(data => regex.test(data.path));
  console.log(`  Matches (${matches.length}):`);
  matches.forEach(match => {
    console.log(`    ✓ ${match.path}`);
  });
  if (matches.length === 0) {
    console.log(`    (no matches)`);
  }
});

console.log('\n🏷️  Device Discovery Simulation:');

// Simulate the device discovery logic
function identifyDeviceType(path) {
  if (path.match(/electrical\.switches\.venus-[01]\./)) return null;
  if (settings.batteryRegex.test(path)) return 'batteries';
  if (settings.tankRegex.test(path)) return 'tanks';
  if (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path)) return 'environment';
  if (settings.switchRegex.test(path) || settings.dimmerRegex.test(path)) return 'switches';
  return null;
}

function getDevicePath(deviceType, fullPath) {
  switch (deviceType) {
    case 'batteries':
      const batteryMatch = fullPath.match(/^(electrical\.batteries\.[^.]+)/);
      return batteryMatch ? batteryMatch[1] : null;
    case 'tanks':
      const tankMatch = fullPath.match(/^(tanks\.[^.]+\.[^.]+)/);
      return tankMatch ? tankMatch[1] : null;
    case 'environment':
      return fullPath;
    case 'switches':
      const switchMatch = fullPath.match(/^(electrical\.switches\.[^.]+)/);
      return switchMatch ? switchMatch[1] : null;
  }
  return null;
}

function generateDisplayName(deviceType, devicePath) {
  switch (deviceType) {
    case 'batteries':
      const batteryMatch = devicePath.match(/electrical\.batteries\.(\d+|[^.]+)/);
      if (batteryMatch) {
        const batteryId = batteryMatch[1];
        return batteryId === '0' ? 'Battery' : `Battery ${batteryId}`;
      }
      return 'Battery';
    case 'tanks':
      const tankMatch = devicePath.match(/tanks\.([^.]+)\.(\d+|[^.]+)/);
      if (tankMatch) {
        const tankType = tankMatch[1];
        const tankId = tankMatch[2];
        const typeNames = {
          'fuel': 'Fuel',
          'freshWater': 'Freshwater',
          'wasteWater': 'Wastewater', 
          'blackWater': 'Blackwater'
        };
        const typeName = typeNames[tankType] || tankType.charAt(0).toUpperCase() + tankType.slice(1);
        return tankId === '0' ? typeName : `${typeName} ${tankId}`;
      }
      return 'Tank';
    case 'environment':
      const envMatch = devicePath.match(/environment\.([^.]+)\.(.+)/) || devicePath.match(/propulsion\.([^.]+)\.(.+)/);
      if (envMatch) {
        const location = envMatch[1];
        const sensor = envMatch[2];
        return `${location.charAt(0).toUpperCase() + location.slice(1)} ${sensor}`;
      }
      return 'Environment';
    case 'switches':
      const switchMatch = devicePath.match(/electrical\.switches\.([^.]+)/);
      if (switchMatch) {
        const switchName = switchMatch[1];
        return switchName.charAt(0).toUpperCase() + switchName.slice(1);
      }
      return 'Switch';
  }
  return devicePath;
}

const discoveredDevices = new Map();

testSignalKData.forEach(data => {
  const deviceType = identifyDeviceType(data.path);
  if (deviceType) {
    const devicePath = getDevicePath(deviceType, data.path);
    if (devicePath) {
      const displayName = generateDisplayName(deviceType, devicePath);
      const key = `${deviceType}:${devicePath}`;
      
      if (!discoveredDevices.has(key)) {
        discoveredDevices.set(key, {
          deviceType,
          devicePath,
          displayName,
          properties: []
        });
      }
      
      discoveredDevices.get(key).properties.push(data.path);
    }
  }
});

console.log(`\nDiscovered ${discoveredDevices.size} unique devices:`);

const groupedDevices = {};
discoveredDevices.forEach(device => {
  if (!groupedDevices[device.deviceType]) {
    groupedDevices[device.deviceType] = [];
  }
  groupedDevices[device.deviceType].push(device);
});

Object.entries(groupedDevices).forEach(([deviceType, devices]) => {
  const typeNames = {
    'batteries': 'Batteries',
    'tanks': 'Tanks', 
    'environment': 'Environment Sensors',
    'switches': 'Switches & Dimmers'
  };
  
  console.log(`\n📂 ${typeNames[deviceType]} (${devices.length}):`);
  devices.forEach((device, index) => {
    console.log(`  ${index + 1}. ${device.displayName}`);
    console.log(`     Path: ${device.devicePath}`);
    console.log(`     Properties: ${device.properties.join(', ')}`);
  });
});

console.log('\n✅ Discovery test complete! These devices would appear in the Signal K plugin configuration UI.');
console.log('\n💡 To test with your actual Signal K server:');
console.log('   1. Install this plugin in your Signal K server'); 
console.log('   2. Enable the plugin');
console.log('   3. Check the plugin configuration page');
console.log('   4. Discovered devices should appear with checkboxes to enable/disable');
