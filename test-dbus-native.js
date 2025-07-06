#!/usr/bin/env node

/**
 * Test script to verify dbus-native interface descriptors and native object returns
 */

import dbusNative from 'dbus-native';

async function testDbusNative() {
  console.log('Testing dbus-native interface descriptors...');
  
  try {
    // Create D-Bus connection using dbus-native with anonymous authentication
    const bus = dbusNative.createClient({
      host: 'venus.local',
      port: 78,
      authMethods: ['ANONYMOUS']
    });
    
    const serviceName = 'com.victronenergy.test.signalk';
    
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
        return ['i', 1]; // Connected = 1 (integer)
      },
      SetValue: (val) => {
        return 0; // Success
      },
      GetText: () => {
        return 'Connected'; // Native string return
      }
    };

    const productNameInterface = {
      GetValue: () => {
        return ['s', 'SignalK Test Device'];
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Product name';
      }
    };

    const deviceInstanceInterface = {
      GetValue: () => {
        return ['u', 999]; // Test device instance
      },
      SetValue: (val) => {
        return 0;
      },
      GetText: () => {
        return 'Device instance';
      }
    };

    // Export interfaces using the descriptor pattern
    bus.exportInterface(mgmtInterface, '/Mgmt/Connection', busItemInterface);
    bus.exportInterface(productNameInterface, '/ProductName', busItemInterface);
    bus.exportInterface(deviceInstanceInterface, '/DeviceInstance', busItemInterface);

    console.log('All interfaces exported successfully!');
    console.log('Press Ctrl+C to exit');
    
    // Keep the process running to maintain D-Bus registration
    process.on('SIGINT', () => {
      console.log('Shutting down...');
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
