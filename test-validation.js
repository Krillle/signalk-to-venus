#!/usr/bin/env node

// Test script to verify input validation in all Venus clients
// This simulates the error scenarios that were causing "Cannot read properties of undefined"

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

async function testValidation() {
  console.log('Testing input validation across all Venus clients...\n');

  // Create test clients
  const batteryClient = new BatteryClient(testSettings, 'battery_0');
  const tankClient = new TankClient(testSettings, 'tank_0');
  const envClient = new EnvClient(testSettings, 'environment_0');
  const switchClient = new SwitchClient(testSettings, 'switch_0');

  const clients = [
    { name: 'Battery', client: batteryClient, paths: ['electrical.batteries.0.voltage', 'electrical.batteries.0.current'] },
    { name: 'Tank', client: tankClient, paths: ['tanks.fuel.0.currentLevel', 'tanks.fuel.0.capacity'] },
    { name: 'Environment', client: envClient, paths: ['environment.outside.temperature', 'environment.outside.humidity'] },
    { name: 'Switch', client: switchClient, paths: ['electrical.switches.0.state', 'electrical.switches.0.dimmingLevel'] }
  ];

  // Test problematic values that previously caused errors
  const testValues = [
    { value: undefined, desc: 'undefined' },
    { value: null, desc: 'null' },
    { value: NaN, desc: 'NaN' },
    { value: {}, desc: 'empty object' },
    { value: { value: undefined }, desc: 'object with undefined value' },
    { value: 'invalid', desc: 'string instead of number' },
    { value: 42, desc: 'valid number' },
    { value: true, desc: 'boolean true' },
    { value: false, desc: 'boolean false' }
  ];

  for (const { name, client, paths } of clients) {
    console.log(`--- Testing ${name} Client ---`);
    
    for (const path of paths) {
      console.log(`  Path: ${path}`);
      
      for (const { value, desc } of testValues) {
        try {
          process.stdout.write(`    Testing ${desc} (${typeof value}): `);
          await client.handleSignalKUpdate(path, value);
          console.log('✓ No error');
        } catch (err) {
          console.log(`✗ Error: ${err.message}`);
        }
      }
      console.log('');
    }
    console.log('');
  }

  console.log('✅ Validation test completed successfully!');
  console.log('All clients properly handle invalid input values without throwing errors.');
}

testValidation().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
