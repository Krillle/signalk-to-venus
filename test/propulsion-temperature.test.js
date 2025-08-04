import { describe, it, beforeEach, expect, vi } from 'vitest';
import pluginExport from '../index.js';

// Mock dependencies
const mockApp = {
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

const mockVenusClient = {
  handleSignalKUpdate: vi.fn(),
  disconnect: vi.fn()
};

const mockVenusClientFactory = vi.fn(() => mockVenusClient);

const mockSettings = {
  venusHost: 'venus.local',
  interval: 1000,
  batteryCapacity: 800,
  batteryRegex: /^electrical\.batteries\.\d+\./,
  tankRegex: /^tanks\.[^.\/]+\.[^.\/]+\./,
  temperatureRegex: /^environment\..*\.temperature$|^propulsion\..*\.temperature$/,
  humidityRegex: /^environment\..*\.(humidity|relativeHumidity)$/,
  switchRegex: /^electrical\.switches\.[^.]+\.state$/,
  dimmerRegex: /^electrical\.switches\.[^.]+\.dimmingLevel$/
};

const mockDbusNative = {
  createClient: vi.fn(() => ({
    listNames: vi.fn((callback) => callback(null, ['test.service'])),
    end: vi.fn()
  }))
};

vi.mock('../venusClientFactory.js', () => ({
  VenusClientFactory: mockVenusClientFactory
}));

vi.mock('../settings.js', () => ({
  default: mockSettings
}));

vi.mock('dbus-native', () => ({
  default: mockDbusNative
}));

describe('Propulsion Temperature Processing', () => {
  let plugin;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock getSelfPath to return appropriate values
    mockApp.getSelfPath.mockImplementation((path) => {
      if (path === 'mmsi') return '123456789';
      if (path === 'propulsion.port.temperature') return 65.5;
      if (path === 'propulsion.main.temperature') return 70.2;
      if (path === '') return { someData: 'exists' }; // For Signal K readiness check
      return null;
    });
    
    // Mock successful Venus connectivity
    mockDbusNative.createClient.mockReturnValue({
      listNames: vi.fn((callback) => callback(null, ['test.service'])),
      end: vi.fn()
    });
    
    // Create plugin instance
    plugin = pluginExport(mockApp);
  });

  describe('Temperature Regex Pattern', () => {
    it('should match propulsion.port.temperature with current regex', () => {
      const path = 'propulsion.port.temperature';
      expect(mockSettings.temperatureRegex.test(path)).toBe(true);
    });

    it('should match other propulsion temperature paths', () => {
      const paths = [
        'propulsion.main.temperature',
        'propulsion.starboard.temperature',
        'propulsion.engine1.temperature'
      ];
      
      paths.forEach(path => {
        expect(mockSettings.temperatureRegex.test(path)).toBe(true);
      });
    });

    it('should NOT match compound temperature words in propulsion paths', () => {
      const paths = [
        'propulsion.port.exhaustTemperature', // This is one word, not ending with .temperature
        'propulsion.port.coolantTemperature',
        'propulsion.port.airTemperature'
      ];
      
      paths.forEach(path => {
        expect(mockSettings.temperatureRegex.test(path)).toBe(false);
      });
    });

    it('should match environment temperature paths', () => {
      const paths = [
        'environment.water.temperature',
        'environment.outside.temperature',
        'environment.inside.temperature'
      ];
      
      paths.forEach(path => {
        expect(mockSettings.temperatureRegex.test(path)).toBe(true);
      });
    });

    it('should NOT match non-temperature propulsion paths', () => {
      const paths = [
        'propulsion.port.revolutions',
        'propulsion.port.oilPressure',
        'propulsion.port.boostPressure',
        'propulsion.port.alternatorVoltage'
      ];
      
      paths.forEach(path => {
        expect(mockSettings.temperatureRegex.test(path)).toBe(false);
      });
    });
  });

  describe('Device Type Identification', () => {
    it('should identify propulsion.port.temperature as environment device type', async () => {
      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': true
        }
      };
      
      // Mock the subscription setup to call our test callback
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for async startup (Signal K readiness + Venus connectivity + subscription setup)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Simulate a delta message with propulsion temperature
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      // Process the delta
      if (deltaCallback) {
        console.log('About to call deltaCallback with:', delta);
        deltaCallback(delta);
        // Wait for async processing to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      } else {
        console.log('ERROR: deltaCallback is not defined!');
      }

      // Check that debug messages include device type identification
      const debugCalls = mockApp.debug.mock.calls.map(call => call[0]);
      console.log('All debug calls:', debugCalls);
      expect(debugCalls).toContain('identifyDeviceType returning \'environment\' for propulsion.port.temperature');
    });

    it('should correctly process propulsion temperature path', async () => {
      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': true
        }
      };

      // Mock successful getSelfPath for current value lookup
      mockApp.getSelfPath.mockReturnValue(65.5);

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate delta with propulsion temperature
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      if (deltaCallback) {
        deltaCallback(delta);
        // Wait for async processing to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Verify Venus client was created for environment device type
      expect(mockVenusClientFactory).toHaveBeenCalledWith(
        expect.objectContaining({
          venusHost: 'venus.local'
        }),
        'environment',
        mockApp
      );

      // Verify the client received the temperature data
      expect(mockVenusClient.handleSignalKUpdate).toHaveBeenCalledWith(
        'propulsion.port.temperature',
        65.5
      );
    });

    it('should discover propulsion temperature device with correct display name', async () => {
      const config = {
        venusHost: 'venus.local'
      };

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate delta with propulsion temperature
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      if (deltaCallback) {
        deltaCallback(delta);
        // Wait for async processing to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Check that debug messages include device discovery
      const debugCalls = mockApp.debug.mock.calls.map(call => call[0]);
      expect(debugCalls).toContain('Discovered new environment device: Port temperature (propulsion.port.temperature)');

      // Generate schema to see if device was discovered
      const schema = plugin.schema();
      
      // Check if environment section exists with our device
      expect(schema.properties.environment).toBeDefined();
      expect(schema.properties.environment.properties.propulsion_port_temperature).toEqual({
        type: 'boolean',
        title: 'Port temperature (propulsion.port.temperature)',
        default: false
      });
    });

    it('should NOT process propulsion temperature if disabled in config', async () => {
      // Clear any previous config state
      vi.clearAllMocks();
      
      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': false // Explicitly disabled
        }
      };

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate delta with propulsion temperature
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      if (deltaCallback) {
        deltaCallback(delta);
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify device was discovered but not enabled
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Discovered new environment device: Port temperature (propulsion.port.temperature)')
      );

      // Verify it was skipped due to being disabled
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping propulsion path propulsion.port.temperature: not enabled in config')
      );

      // Venus client should NOT be created
      expect(mockVenusClientFactory).not.toHaveBeenCalled();
    });

    it('should handle Venus OS connectivity failure gracefully', async () => {
      // Mock Venus connectivity failure
      mockDbusNative.createClient.mockReturnValue({
        listNames: vi.fn((callback) => callback(new Error('ECONNREFUSED'), null)),
        end: vi.fn()
      });

      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': true
        }
      };

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup and connectivity test
      await new Promise(resolve => setTimeout(resolve, 200));

      // Simulate delta with propulsion temperature
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: 65.5
          }]
        }]
      };

      if (deltaCallback) {
        deltaCallback(delta);
        // Wait for async processing to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Verify device discovery happened
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Discovered new environment device: Port temperature (propulsion.port.temperature)')
      );

      // Verify path was queued due to Venus not being connected
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Queued propulsion path: propulsion.port.temperature (Venus not connected)')
      );

      // Venus client should NOT be created yet
      expect(mockVenusClientFactory).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple propulsion temperature sensors', async () => {
      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': true,
          'propulsion_main_temperature': true
        }
      };

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate deltas with multiple propulsion temperatures
      const deltas = [
        {
          updates: [{
            source: { label: 'test.nmea' },
            values: [{
              path: 'propulsion.port.temperature',
              value: 65.5
            }]
          }]
        },
        {
          updates: [{
            source: { label: 'test.nmea' },
            values: [{
              path: 'propulsion.main.temperature',
              value: 70.2
            }]
          }]
        }
      ];

      for (const delta of deltas) {
        if (deltaCallback) {
          deltaCallback(delta);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify both devices were discovered
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Discovered new environment device: Port temperature (propulsion.port.temperature)')
      );
      expect(mockApp.debug).toHaveBeenCalledWith(
        expect.stringContaining('Discovered new environment device: Main temperature (propulsion.main.temperature)')
      );

      // Schema should contain both devices
      const schema = plugin.schema();
      expect(schema.properties.environment.properties.propulsion_port_temperature).toBeDefined();
      expect(schema.properties.environment.properties.propulsion_main_temperature).toBeDefined();
    });

    it('should handle null temperature values gracefully', async () => {
      const config = {
        venusHost: 'venus.local',
        environment: {
          'propulsion_port_temperature': true
        }
      };

      // Mock the subscription setup
      let deltaCallback;
      mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
        deltaCallback = callback;
        unsubscribes.push(() => {});
      });

      // Start the plugin
      plugin.start(config);

      // Wait for startup
      await new Promise(resolve => setTimeout(resolve, 100));

      // Simulate delta with null temperature value
      const delta = {
        updates: [{
          source: { label: 'test.nmea' },
          values: [{
            path: 'propulsion.port.temperature',
            value: null
          }]
        }]
      };

      if (deltaCallback) {
        deltaCallback(delta);
      }

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not cause errors and should be skipped
      expect(mockApp.error).not.toHaveBeenCalled();
      expect(mockVenusClientFactory).not.toHaveBeenCalled();
    });
  });
});
