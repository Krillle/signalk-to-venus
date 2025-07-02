#!/usr/bin/env node

/**
 * Test script to verify dbus-native interface descriptors and native object returns
 */

import dbusNative from 'dbus-native';

async function testDbusNative() {
  console.log('Testing dbus-native interface descriptors and return types...');
  
  try {
    // Create D-Bus connection using dbus-native with anonymous authentication
    const bus = dbusNative.createClient({
      host: 'venus.local',
      port: 78,
      authMethods: ['ANONYMOUS']
    });
    
    const serviceName = 'com.victronenergy.test.signalk';
    
    console.log(`Requesting service name: ${serviceName}`);
    
    // Request service name
    await new Promise((resolve, reject) => {
      bus.requestName(serviceName, 0, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    console.log('Service name acquired successfully');

    // Define the BusItem interface descriptor for dbus-native
    const busItemInterface = {
      name: "com.victronenergy.BusItem",
      methods: {
        GetValue: ["", "v", [], ["value"]],
        SetValue: ["v", "i", [], []],
        GetText: ["", "s", [], ["text"]],
      },
    };

    // Create test interfaces with native object returns
    const mgmtInterface = {
      GetValue: () => {
        console.log('Management GetValue called - returning native integer');
        return ['i', 1]; // Connected = 1 (integer)
      },
      SetValue: (val) => {
        console.log('Management SetValue called with:', val);
        return 0; // Success
      },
      GetText: () => {
        console.log('Management GetText called - returning native string');
        return 'Connected'; // Native string return
      }
    };

    const productNameInterface = {
      GetValue: () => {
        console.log('ProductName GetValue called - returning string array');
        return ['s', 'SignalK Test Device'];
      },
      SetValue: (val) => {
        console.log('ProductName SetValue called with:', val);
        return 0;
      },
      GetText: () => {
        console.log('ProductName GetText called - returning native string');
        return 'Product name';
      }
    };

    const deviceInstanceInterface = {
      GetValue: () => {
        console.log('DeviceInstance GetValue called - returning unsigned integer');
        return ['u', 999]; // Test device instance
      },
      SetValue: (val) => {
        console.log('DeviceInstance SetValue called with:', val);
        return 0;
      },
      GetText: () => {
        console.log('DeviceInstance GetText called - returning native string');
        return 'Device instance';
      }
    };

    // Export interfaces using the descriptor pattern
    console.log('Exporting management interface...');
    bus.exportInterface(mgmtInterface, '/Mgmt/Connection', busItemInterface);
    
    console.log('Exporting product name interface...');
    bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);
    
    console.log('Exporting device instance interface...');
    bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);

    console.log('\nAll interfaces exported successfully with dbus-native!');
    console.log('Service should now be visible on D-Bus with correct interface descriptors');
    console.log('\nPress Ctrl+C to exit and test with d-bus introspection tools');
    
    // Keep the process running to maintain D-Bus registration
    process.on('SIGINT', () => {
      console.log('\nShutting down test service...');
      process.exit(0);
    });
    
    // Prevent process from exiting
    setInterval(() => {}, 1000);
    
  } catch (err) {
    console.error('Error testing dbus-native:', err.message);
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      console.error('Cannot connect to Venus OS at venus.local:78');
      console.error('Make sure Venus OS is accessible and dbus-tcp is enabled');
    }
  }
}

// Run the test
testDbusNative();
