#!/usr/bin/env node

// Test script to verify regex patterns work with actual Signal K paths
import settings from './settings.js';

const testPaths = [
  // Battery paths from your Signal K data
  'electrical.batteries.0.capacity.stateOfCharge',
  'electrical.batteries.0.capacity.timeRemaining', 
  'electrical.batteries.0.current',
  'electrical.batteries.0.voltage',
  'electrical.batteries.1.voltage',
  
  // Tank paths from your Signal K data
  'tanks.blackWater.0.capacity',
  'tanks.blackWater.0.currentLevel',
  'tanks.freshWater.0.capacity', 
  'tanks.freshWater.0.currentLevel',
  'tanks.fuel.0.capacity',
  'tanks.fuel.0.currentLevel',
  'tanks.wasteWater.0.capacity',
  'tanks.wasteWater.0.currentLevel',
  
  // Environment paths from your Signal K data
  'environment.water.temperature',
  
  // Test paths that should NOT match
  'navigation.position',
  'electrical.inverters.0.voltage',
  'unknown.path.test'
];

console.log('Testing regex patterns against actual Signal K paths...\n');

testPaths.forEach(path => {
  const results = {
    battery: settings.batteryRegex.test(path),
    tank: settings.tankRegex.test(path),
    temperature: settings.temperatureRegex.test(path),
    humidity: settings.humidityRegex.test(path),
    switch: settings.switchRegex.test(path),
    dimmer: settings.dimmerRegex.test(path)
  };
  
  const matches = Object.keys(results).filter(key => results[key]);
  
  console.log(`Path: ${path}`);
  if (matches.length > 0) {
    console.log(`  ✅ Matches: ${matches.join(', ')}`);
  } else {
    console.log(`  ❌ No matches`);
  }
  console.log('');
});

console.log('\nRegex patterns being tested:');
console.log('Battery:', settings.batteryRegex.toString());
console.log('Tank:', settings.tankRegex.toString());
console.log('Temperature:', settings.temperatureRegex.toString());
console.log('Humidity:', settings.humidityRegex.toString());
console.log('Switch:', settings.switchRegex.toString());
console.log('Dimmer:', settings.dimmerRegex.toString());
