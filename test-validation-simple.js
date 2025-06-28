#!/usr/bin/env node

// Simple validation test - tests only input validation without attempting connections
// This verifies that "Cannot read properties of undefined" errors are eliminated

import { VenusClient as BatteryClient } from './venusClient-battery.js';
import { VenusClient as TankClient } from './venusClient-tank.js';
import { VenusClient as EnvClient } from './venusClient-env.js';
import { VenusClient as SwitchClient } from './venusClient-switch.js';

const testSettings = {
  venusHost: 'localhost',
  enabledDevices: {
    battery: true,
    tank: true,
    environment: true,
    switch: true
  }
};

async function testInputValidation() {
  console.log('🧪 Testing input validation to prevent "Cannot read properties of undefined" errors\n');

  // Create test clients (without connecting)
  const clients = [
    { name: 'Battery', client: new BatteryClient(testSettings, 'battery_0'), paths: ['electrical.batteries.0.voltage'] },
    { name: 'Tank', client: new TankClient(testSettings, 'tank_0'), paths: ['tanks.fuel.0.currentLevel'] },
    { name: 'Environment', client: new EnvClient(testSettings, 'environment_0'), paths: ['environment.outside.temperature'] },
    { name: 'Switch', client: new SwitchClient(testSettings, 'switch_0'), paths: ['electrical.switches.0.state'] }
  ];

  // Test the exact problematic values from the error logs
  const problematicValues = [
    { value: undefined, desc: 'undefined' },
    { value: null, desc: 'null' },
    { value: NaN, desc: 'NaN' },
    { value: {}, desc: 'empty object' },
    { value: { value: undefined }, desc: 'object with undefined value property' },
    { value: 'string', desc: 'string instead of number' }
  ];

  let totalTests = 0;
  let passedTests = 0;

  for (const { name, client, paths } of clients) {
    console.log(`--- ${name} Client ---`);
    
    for (const path of paths) {
      for (const { value, desc } of problematicValues) {
        totalTests++;
        
        try {
          // This should NOT throw "Cannot read properties of undefined" errors
          await client.handleSignalKUpdate(path, value);
          console.log(`✅ ${desc}: Properly handled (no errors)`);
          passedTests++;
        } catch (err) {
          // Connection errors are expected and OK
          if (err.message && (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND') || err.message.includes('timeout'))) {
            console.log(`✅ ${desc}: Properly handled (connection error expected)`);
            passedTests++;
          } else {
            // This would be a real validation error
            console.log(`❌ ${desc}: Validation error - ${err.message}`);
          }
        }
      }
    }
    console.log('');
  }

  console.log(`📊 Test Results: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 SUCCESS: All input validation is working correctly!');
    console.log('   No more "Cannot read properties of undefined" errors should occur.');
  } else {
    console.log('❌ FAILURE: Some validation issues remain.');
    process.exit(1);
  }
}

testInputValidation().catch(err => {
  console.error('❌ Test script error:', err.message);
  process.exit(1);
});
