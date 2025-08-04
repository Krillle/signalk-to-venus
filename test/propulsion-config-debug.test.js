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

describe('Propulsion Config Debug', () => {
  let plugin;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock getSelfPath to return appropriate values
    mockApp.getSelfPath.mockImplementation((path) => {
      if (path === 'mmsi') return '123456789';
      if (path === 'propulsion.port.temperature') return 65.5;
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

  it('should log config details for propulsion.port.temperature', async () => {
    const config = {
      venusHost: 'venus.local',
      environment: {
        'propulsion_port_temperature': true // Explicitly enabled
      }
    };

    // Mock the subscription setup
    let deltaCallback;
    mockApp.subscriptionmanager.subscribe.mockImplementation((subscription, unsubscribes, errorCallback, callback) => {
      deltaCallback = callback;
      unsubscribes.push(() => {});
    });

    // Start the plugin (this should trigger config logging)
    plugin.start(config);

    // Wait for startup
    await new Promise(resolve => setTimeout(resolve, 500));

    // Simulate delta with propulsion.port.temperature
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
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Check all debug calls
    const debugCalls = mockApp.debug.mock.calls.map(call => call.join(' '));
    console.log('=== ALL DEBUG CALLS ===');
    debugCalls.forEach((call, index) => {
      console.log(`${index + 1}: ${call}`);
    });
    console.log('=== END DEBUG CALLS ===');

    // Check that config logging happened
    const configLogFound = debugCalls.some(call => 
      call.includes('PROPULSION PORT TEMP CONFIG')
    );
    expect(configLogFound).toBe(true);

    // Check that processing logging happened
    const processingLogFound = debugCalls.some(call => 
      call.includes('=== PROPULSION PORT TEMP')
    );
    expect(processingLogFound).toBe(true);
  });
});
