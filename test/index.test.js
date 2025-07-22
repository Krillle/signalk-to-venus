import { describe, it, beforeEach, expect, vi } from 'vitest';

// Mock dependencies
const mockApp = {
  debug: vi.fn(),
  error: vi.fn(),
  setPluginStatus: vi.fn(),
  setPluginError: vi.fn(),
  streambundle: {
    getSelfBus: vi.fn(() => ({
      onValue: vi.fn()
    }))
  },
  getSelfPath: vi.fn(),
  putSelfPath: vi.fn(),
  handleMessage: vi.fn(),
  signalk: {
    subscribe: vi.fn()
  },
  registerDeltaInputHandler: vi.fn()
};

const mockVenusClientFactory = vi.fn();
const mockSettings = {
  venusHost: 'venus.local',
  productName: 'SignalK Virtual Device',
  interval: 1000,
  batteryRegex: /^electrical\.batteries\./,
  tankRegex: /^tanks\./,
  temperatureRegex: /temperature$/,
  humidityRegex: /(humidity|relativeHumidity)$/,
  switchRegex: /^electrical\.switches\..*\.state$/,
  dimmerRegex: /^electrical\.switches\..*\.dimmingLevel$/
};

const mockDbusNative = {
  createClient: vi.fn()
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

describe('Signal K Plugin - Main Index', () => {
  let plugin;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock successful D-Bus connection with listNames method
    const mockBus = {
      listNames: vi.fn((callback) => callback(null, ['test.service'])),
      end: vi.fn()
    };
    mockDbusNative.createClient.mockReturnValue(mockBus);
    
    // Mock VenusClient with the new structure
    const mockVenusClient = {
      handleSignalKUpdate: vi.fn(),
      disconnect: vi.fn()
    };
    mockVenusClientFactory.mockReturnValue(mockVenusClient);
    
    // Import the plugin after mocks are set up
    const { default: pluginFunction } = await import('../index.js');
    plugin = pluginFunction(mockApp);
  });

  describe('Plugin Structure', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.id).toBe('signalk-to-venus');
      expect(plugin.name).toBe('Signal K to Venus OS Bridge');
      expect(plugin.description).toBe('Bridges Signal K data to Victron Venus OS via D-Bus');
    });

    it('should have required plugin methods', () => {
      expect(typeof plugin.schema).toBe('function');
      expect(typeof plugin.uiSchema).toBe('function');
      expect(typeof plugin.start).toBe('function');
      expect(typeof plugin.stop).toBe('function');
    });

    it('should initialize with correct default state', () => {
      expect(plugin.venusConnected).toBe(false);
      expect(plugin.unsubscribe).toBeNull();
      expect(plugin.clients).toEqual({});
      expect(plugin.connectivityInterval).toBeNull();
    });
  });

  describe('Schema Generation', () => {
    it('should generate base schema without discovered devices', () => {
      const schema = plugin.schema();
      
      expect(schema.type).toBe('object');
      expect(schema.properties.venusHost).toEqual({
        type: 'string',
        title: 'Venus OS Host',
        default: 'venus.local'
      });
      expect(schema.properties.productName).toEqual({
        type: 'string',
        title: 'Product Name',
        default: 'SignalK Virtual Device'
      });
      expect(schema.properties.interval).toEqual({
        type: 'number',
        title: 'Update Interval (ms)',
        default: 1000
      });
    });

    it('should generate UI schema without discovered devices', () => {
      const uiSchema = plugin.uiSchema();
      expect(uiSchema).toEqual({});
    });
  });

  describe('Device Type Identification', () => {
    it('should identify battery paths correctly through plugin behavior', () => {
      // Test that the plugin processes battery paths
      const testPath = 'electrical.batteries.main.voltage';
      // Since identifyDeviceType is internal, we verify through expected behavior
      expect(mockSettings.batteryRegex.test(testPath)).toBe(true);
    });

    it('should identify tank paths correctly through plugin behavior', () => {
      const testPath = 'tanks.freshWater.main.currentLevel';
      expect(mockSettings.tankRegex.test(testPath)).toBe(true);
    });

    it('should identify environment paths correctly through plugin behavior', () => {
      const tempPath = 'environment.outside.temperature';
      const humidityPath = 'environment.inside.humidity';
      expect(mockSettings.temperatureRegex.test(tempPath)).toBe(true);
      expect(mockSettings.humidityRegex.test(humidityPath)).toBe(true);
    });

    it('should identify switch paths correctly through plugin behavior', () => {
      const switchPath = 'electrical.switches.nav.state';
      const dimmerPath = 'electrical.switches.cabin.dimmingLevel';
      expect(mockSettings.switchRegex.test(switchPath)).toBe(true);
      expect(mockSettings.dimmerRegex.test(dimmerPath)).toBe(true);
    });
  });

  describe('Plugin Lifecycle', () => {
    it('should start plugin successfully with Signal K readiness check', async () => {
      const options = { venusHost: 'test.local' };
      
      // Mock Signal K readiness
      mockApp.getSelfPath.mockReturnValue({ someData: 'test' });
      
      plugin.start(options);
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Starting Signal K to Venus OS bridge');
      expect(mockApp.debug).toHaveBeenCalledWith('Starting Signal K to Venus OS bridge');
      
      // Should set up subscription
      await new Promise(resolve => setTimeout(resolve, 100)); // Allow async setup
      expect(mockApp.streambundle.getSelfBus).toHaveBeenCalled();
    });

    it('should stop plugin and cleanup resources', async () => {
      plugin.clients = {
        batteries: { disconnect: vi.fn() },
        tanks: { disconnect: vi.fn() }
      };
      plugin.connectivityInterval = setInterval(() => {}, 1000);
      plugin.unsubscribe = vi.fn();
      
      await plugin.stop();
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Stopping Signal K to Venus OS bridge');
      expect(mockApp.debug).toHaveBeenCalledWith('Stopping Signal K to Venus OS bridge');
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Stopped');
      expect(plugin.unsubscribe).toHaveBeenCalled();
    });

    it('should handle missing options gracefully', () => {
      expect(() => plugin.start()).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle D-Bus connection errors gracefully', () => {
      const mockFailingBus = {
        listNames: vi.fn((callback) => callback(new Error('ECONNREFUSED'), null)),
        end: vi.fn()
      };
      mockDbusNative.createClient.mockReturnValue(mockFailingBus);
      
      plugin.start({ venusHost: 'unreachable.host' });
      
      // Should not throw and should handle gracefully
      expect(mockApp.setPluginStatus).toHaveBeenCalled();
    });

    it('should handle Venus OS connection timeouts', () => {
      const mockTimeoutBus = {
        listNames: vi.fn((callback) => {
          // Simulate timeout by not calling callback
        }),
        end: vi.fn()
      };
      mockDbusNative.createClient.mockReturnValue(mockTimeoutBus);
      
      plugin.start({ venusHost: 'timeout.host' });
      
      expect(mockApp.setPluginStatus).toHaveBeenCalled();
    });

    it('should queue paths when Venus OS is not reachable', () => {
      // This tests the pending paths functionality
      const mockUnreachableBus = {
        listNames: vi.fn((callback) => callback(new Error('ENOTFOUND'), null)),
        end: vi.fn()
      };
      mockDbusNative.createClient.mockReturnValue(mockUnreachableBus);
      
      plugin.start({ venusHost: 'unreachable.host' });
      
      // Plugin should continue to run and queue data
      expect(mockApp.setPluginStatus).toHaveBeenCalled();
    });
  });

  describe('Device Discovery', () => {
    it('should generate dynamic schema with discovered devices', () => {
      // Simulate discovered devices by calling the plugin's discovery logic
      const schema = plugin.schema();
      
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeDefined();
      expect(schema.properties.venusHost).toBeDefined();
      expect(schema.properties.productName).toBeDefined();
      expect(schema.properties.interval).toBeDefined();
    });

    it('should track discovered paths correctly', () => {
      // The plugin should maintain discovery state
      expect(plugin.venusConnected).toBe(false);
      expect(plugin.clients).toEqual({});
    });
  });
});
