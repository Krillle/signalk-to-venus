#!/usr/bin/env node

// Test script to verify that Cerbo GX relay filtering works correctly
import settings from './settings.js';

// Mock app object
const app = {
  debug: (msg) => console.log(`DEBUG: ${msg}`),
  error: (msg) => console.log(`ERROR: ${msg}`)
};

// Simulate the identifyDeviceType function from index.js
function identifyDeviceType(path, config) {
  // Filter out Cerbo GX relays (venus-0, venus-1) to prevent feedback loops
  if (path.match(/electrical\.switches\.venus-[01]\./)) {
    app.debug(`Skipping Cerbo GX relay path: ${path}`);
    return null;
  }
  
  if ((config.enabledDevices?.batteries !== false) && settings.batteryRegex.test(path)) return 'battery';
  if ((config.enabledDevices?.tanks !== false) && settings.tankRegex.test(path)) return 'tank';
  if ((config.enabledDevices?.environment !== false) && (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path))) return 'env';
  if ((config.enabledDevices?.switches !== false) && (settings.switchRegex.test(path) || settings.dimmerRegex.test(path))) return 'switch';
  return null;
}

// Simulate the mapVenusToSignalKPath function from index.js
function mapVenusToSignalKPath(venusPath) {
  if (venusPath.includes('/Switches/')) {
    const id = venusPath.match(/\/Switches\/([^\/]+)/)?.[1];
    
    // Filter out Cerbo GX relays to prevent feedback loops
    if (id === 'venus-0' || id === 'venus-1') {
      return null;
    }
    
    if (venusPath.endsWith('/State')) {
      return `electrical.switches.${id}.state`;
    } else if (venusPath.endsWith('/DimLevel')) {
      return `electrical.switches.${id}.dimmingLevel`;
    }
  }
  return null;
}

const config = {
  enabledDevices: {
    batteries: true,
    tanks: true,
    environment: true,
    switches: true
  }
};

console.log('=== Testing Cerbo GX Relay Filtering ===\n');

// Test paths that should be filtered out
const filteredPaths = [
  'electrical.switches.venus-0.state',
  'electrical.switches.venus-1.state',
  'electrical.switches.venus-0.dimmingLevel',
  'electrical.switches.venus-1.dimmingLevel'
];

console.log('Testing Signal K to Venus OS filtering (should be filtered out):');
filteredPaths.forEach(path => {
  const result = identifyDeviceType(path, config);
  console.log(`  ${path} -> ${result === null ? 'FILTERED OUT ✓' : 'ALLOWED ✗'}`);
});

// Test paths that should be allowed
const allowedPaths = [
  'electrical.switches.0.state',
  'electrical.switches.1.state', 
  'electrical.switches.deck-light.state',
  'electrical.switches.nav-lights.dimmingLevel'
];

console.log('\nTesting normal switch paths (should be allowed):');
allowedPaths.forEach(path => {
  const result = identifyDeviceType(path, config);
  console.log(`  ${path} -> ${result === 'switch' ? 'ALLOWED ✓' : 'FILTERED ✗'}`);
});

// Test Venus OS to Signal K filtering
const venusPaths = [
  '/com/victronenergy/virtual/switch/Switches/venus-0/State',
  '/com/victronenergy/virtual/switch/Switches/venus-1/State',
  '/com/victronenergy/virtual/switch/Switches/0/State',
  '/com/victronenergy/virtual/switch/Switches/deck-light/State'
];

console.log('\nTesting Venus OS to Signal K filtering:');
venusPaths.forEach(venusPath => {
  const result = mapVenusToSignalKPath(venusPath);
  const isFiltered = result === null;
  const shouldBeFiltered = venusPath.includes('venus-0') || venusPath.includes('venus-1');
  const status = (isFiltered === shouldBeFiltered) ? '✓' : '✗';
  console.log(`  ${venusPath} -> ${result || 'FILTERED OUT'} ${status}`);
});

console.log('\n=== Test Complete ===');
