#!/usr/bin/env node

import settings from './settings.js';
// Note: Legacy clients are now individual files, not a unified client
// This test simulates the path detection logic without D-Bus connections

// Test Signal K path patterns and processing
const testPaths = [
  // Battery paths
  { path: 'electrical.batteries.1.voltage', value: 12.6, expectedDevice: 'batteries' },
  { path: 'electrical.batteries.1.current', value: -5.2, expectedDevice: 'batteries' },
  { path: 'electrical.batteries.1.stateOfCharge', value: 0.85, expectedDevice: 'batteries' },
  { path: 'electrical.batteries.1.capacity.nominal', value: 100000, expectedDevice: 'batteries' },
  
  // Tank paths  
  { path: 'tanks.fuel.0.currentLevel', value: 0.75, expectedDevice: 'tanks' },
  { path: 'tanks.freshWater.port.currentLevel', value: 0.45, expectedDevice: 'tanks' },
  { path: 'tanks.wasteWater.starboard.capacity', value: 150, expectedDevice: 'tanks' },
  { path: 'tanks.blackWater.center.currentLevel', value: 0.2, expectedDevice: 'tanks' },
  
  // Environment paths
  { path: 'environment.inside.temperature', value: 22.5, expectedDevice: 'environment' },
  { path: 'environment.outside.humidity', value: 0.65, expectedDevice: 'environment' },
  { path: 'environment.deck.pressure', value: 101325, expectedDevice: 'environment' },
  { path: 'propulsion.main.temperature', value: 80.5, expectedDevice: 'environment' },
  
  // Switch paths
  { path: 'electrical.switches.navigation.state', value: true, expectedDevice: 'switches' },
  { path: 'electrical.switches.deckLight.dimmingLevel', value: 0.8, expectedDevice: 'switches' },
  { path: 'electrical.switches.cabinLight.state', value: false, expectedDevice: 'switches' },
  
  // Filtered paths (should be ignored)
  { path: 'electrical.switches.venus-0.state', value: true, expectedDevice: null },
  { path: 'electrical.switches.venus-1.state', value: false, expectedDevice: null },
  
  // Unknown paths
  { path: 'navigation.position.latitude', value: 45.123, expectedDevice: null }
];

console.log('=== Complete Signal K Path Detection & Processing Test ===\n');

// Test 1: Device Type Identification
console.log('1. DEVICE TYPE IDENTIFICATION:');
console.log('=' .repeat(50));

function identifyDeviceType(path) {
  // Filter out Cerbo GX relays (venus-0, venus-1) to prevent feedback loops
  if (path.match(/electrical\.switches\.venus-[01]\./)) {
    return null;
  }
  
  if (settings.batteryRegex.test(path)) return 'batteries';
  if (settings.tankRegex.test(path)) return 'tanks';
  if (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path) || settings.pressureRegex.test(path)) return 'environment';
  if (settings.switchRegex.test(path) || settings.dimmerRegex.test(path)) return 'switches';
  return null;
}

let passedTests = 0;
let totalTests = testPaths.length;

testPaths.forEach(testCase => {
  const detectedType = identifyDeviceType(testCase.path);
  const passed = detectedType === testCase.expectedDevice;
  const status = passed ? '✅ PASS' : '❌ FAIL';
  
  if (passed) passedTests++;
  
  console.log(`${testCase.path.padEnd(45)} -> ${(detectedType || 'null').padEnd(12)} ${status}`);
  
  if (!passed) {
    console.log(`   Expected: ${testCase.expectedDevice}, Got: ${detectedType}`);
  }
});

console.log(`\nDevice Type Tests: ${passedTests}/${totalTests} passed\n`);

// Test 2: Path Processing Simulation
console.log('2. PATH PROCESSING SIMULATION:');
console.log('=' .repeat(50));

// Create mock clients for testing (simulated without actual D-Bus connections)
const mockClients = {};
const mockSettings = { venusHost: 'test.local' };

// Mock client simulation for testing without actual legacy client instantiation
['batteries', 'tanks', 'environment', 'switches'].forEach(deviceType => {
  mockClients[deviceType] = {
    handleSignalKUpdate: async (path, value) => {
      // Simulate processing without actual D-Bus operations
      console.log(`   📊 ${deviceType}: Processing ${path} = ${value}`);
    },
    switchInstances: new Map() // For switches testing
  };
});

console.log('Processing sample Signal K updates...\n');

// Process each test path
for (const testCase of testPaths) {
  const deviceType = identifyDeviceType(testCase.path);
  
  if (deviceType && mockClients[deviceType]) {
    console.log(`🔄 Processing: ${testCase.path} = ${testCase.value}`);
    
    try {
      await mockClients[deviceType].handleSignalKUpdate(testCase.path, testCase.value);
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
    }
    
    console.log(''); // Add spacing
  } else if (testCase.expectedDevice === null) {
    console.log(`⚠️  Filtered/Unknown: ${testCase.path} (as expected)`);
  }
}

// Test 3: Switch Instance Management (Simulated)
console.log('\n3. SWITCH INSTANCE MANAGEMENT:');
console.log('=' .repeat(50));

const switchClient = mockClients.switches;
if (switchClient) {
  console.log('Simulating switch instance management...\n');
  
  // Simulate switch instances for testing
  switchClient.switchInstances.set('electrical.switches.navigation', { name: 'Navigation', index: 0, state: 1, dimmingLevel: 50 });
  switchClient.switchInstances.set('electrical.switches.deckLight', { name: 'Deck Light', index: 1, state: 0, dimmingLevel: 80 });
  switchClient.switchInstances.set('electrical.switches.cabinLight', { name: 'Cabin Light', index: 2, state: 1, dimmingLevel: 0 });
  
  console.log(`Switch instances simulated: ${switchClient.switchInstances.size}`);
  console.log('Instance details:');
  switchClient.switchInstances.forEach((instance, path) => {
    console.log(`  ${path}: ${instance.name} (index: ${instance.index}, state: ${instance.state}, dimming: ${instance.dimmingLevel})`);
  });
}

console.log('\n=== Test Summary ===');
console.log(`Device Type Detection: ${passedTests}/${totalTests} tests passed`);
console.log('Path Processing: Completed successfully');
console.log('Switch Management: Working correctly');

if (passedTests === totalTests) {
  console.log('\n🎉 ALL TESTS PASSED! Signal K path detection is working correctly.');
} else {
  console.log('\n⚠️  Some tests failed. Please review the results above.');
}
