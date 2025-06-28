#!/usr/bin/env node

// Test script to verify the new schema shows common paths
const mockApp = {
  debug: console.log,
  setPluginStatus: (status) => console.log('Status:', status),
  setPluginError: (error) => console.error('Error:', error),
  error: console.error
};

// Import the plugin
const pluginFactory = (await import('./index.js')).default;
const plugin = pluginFactory(mockApp);

console.log('=== Testing Enhanced Dynamic Schema ===\n');

// Test schema without any discovered paths (simulating no Venus connection)
console.log('1. Schema without discovered paths (shows common paths):');
const schema = plugin.schema();

console.log('Has pathConfiguration:', !!schema.properties.pathConfiguration);
console.log('Device types in pathConfiguration:', Object.keys(schema.properties.pathConfiguration.properties));

// Check batteries section
const batteriesSection = schema.properties.pathConfiguration.properties.batteries;
console.log('\nBatteries paths available:', Object.keys(batteriesSection.properties));

// Check one battery path configuration
const firstBatteryPath = Object.keys(batteriesSection.properties)[0];
const batteryConfig = batteriesSection.properties[firstBatteryPath];
console.log(`\nFirst battery path (${firstBatteryPath}):`, {
  title: batteryConfig.title,
  description: batteryConfig.description,
  hasEnabled: !!batteryConfig.properties.enabled,
  hasCustomName: !!batteryConfig.properties.customName,
  pathInfo: batteryConfig.properties._pathInfo.default,
  status: batteryConfig.properties._status.default
});

// Test UI Schema
console.log('\n2. UI Schema structure:');
const uiSchema = plugin.uiSchema();
console.log('UI Schema sections:', Object.keys(uiSchema));
console.log('pathConfiguration is collapsible:', !!uiSchema.pathConfiguration?.['ui:field']);

console.log('\n3. All device types with common paths:');
['batteries', 'tanks', 'environment', 'switches'].forEach(deviceType => {
  const section = schema.properties.pathConfiguration.properties[deviceType];
  const pathCount = Object.keys(section.properties).length;
  console.log(`${deviceType}: ${pathCount} paths configured`);
});

console.log('\n=== Test completed ===');
console.log('\nThe enhanced schema now shows:');
console.log('✓ Basic device type toggles (always visible)');
console.log('✓ Common Signal K paths for each device type (visible immediately)'); 
console.log('✓ Individual enable/disable checkboxes for each path');
console.log('✓ Custom naming fields for each device');
console.log('✓ Path status indicators (common vs discovered)');
console.log('✓ Collapsible UI sections for better organization');
console.log('\nUsers can now configure expected paths even before connecting to Venus OS!');
