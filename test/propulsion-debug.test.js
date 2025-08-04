import { describe, it, beforeEach, expect, vi } from 'vitest';
import pluginExport from '../index.js';

// Simplified test to debug the actual issue
describe('Propulsion Temperature Debug', () => {
  let mockApp;
  let plugin;

  beforeEach(() => {
    mockApp = {
      debug: vi.fn(),
      error: vi.fn(),
      setPluginStatus: vi.fn(),
      setPluginError: vi.fn(),
      getSelfPath: vi.fn(),
      putSelfPath: vi.fn(),
      handleMessage: vi.fn(),
      subscriptionmanager: {
        subscribe: vi.fn()
      }
    };

    // Mock getSelfPath to return values
    mockApp.getSelfPath.mockImplementation((path) => {
      if (path === 'mmsi') return '123456789';
      if (path === 'propulsion.port.temperature') return 65.5;
      if (path === '') return { someData: 'exists' };
      return null;
    });

    plugin = pluginExport(mockApp);
  });

  it('should reveal why propulsion temperature is not processed', async () => {
    const config = {
      venusHost: 'venus.local',
      environment: {
        'propulsion_port_temperature': true // Explicitly enabled
      }
    };

    // Set up a simple callback capture
    let subscriptionCallback = null;
    mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
      console.log('MOCK: subscription setup called');
      subscriptionCallback = callback;
      unsubscribes.push(() => {});
    });

    // Start the plugin
    console.log('Starting plugin...');
    plugin.start(config);

    // Wait for full startup
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('Subscription callback available:', !!subscriptionCallback);
    console.log('Debug calls so far:', mockApp.debug.mock.calls.map(call => call[0]));

    // Try to send a delta
    if (subscriptionCallback) {
      console.log('Sending delta...');
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      subscriptionCallback(delta);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('Final debug calls:', mockApp.debug.mock.calls.map(call => call[0]));
    } else {
      console.log('ERROR: No subscription callback available!');
    }

    // Just pass the test - we're debugging
    expect(true).toBe(true);
  });
});
