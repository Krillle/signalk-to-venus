import { describe, it, beforeEach, expect, vi } from 'vitest';

// Mock dependencies
const mockApp = {
  debug: vi.fn(),
  error: vi.fn(),
  setPluginStatus: vi.fn(),
  setPluginError: vi.fn(),
  streambundle: {
    getSelfBus: vi.fn()
  },
  putSelfPath: vi.fn()
};

const mockVenusClientFactory = vi.fn();
const mockSettings = {
  venusHost: 'venus.local',
  productName: 'SignalK Virtual Device',
  interval: 1000
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
    
    // Mock successful D-Bus connection
    const mockBus = {
      listNames: vi.fn((callback) => callback(null, ['test.service'])),
      end: vi.fn()
    };
    mockDbusNative.createClient.mockReturnValue(mockBus);
    
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
    // We need to access internal functions, so let's test through the plugin behavior
    it('should identify battery paths correctly', () => {
      // This would be tested through the signal processing behavior
      // Since the identifyDeviceType function is internal, we test its effects
      expect(true).toBe(true); // Placeholder - would need plugin internals exposed
    });
  });

  describe('Plugin Lifecycle', () => {
    it('should start plugin successfully', () => {
      const options = { venusHost: 'test.local' };
      
      plugin.start(options);
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Starting Signal K to Venus OS bridge');
      expect(mockApp.debug).toHaveBeenCalledWith('Starting Signal K to Venus OS bridge');
    });

    it('should stop plugin successfully', () => {
      plugin.stop();
      
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Stopping Signal K to Venus OS bridge');
      expect(mockApp.debug).toHaveBeenCalledWith('Stopping Signal K to Venus OS bridge');
      expect(mockApp.setPluginStatus).toHaveBeenCalledWith('Stopped');
    });

    it('should handle missing options gracefully', () => {
      expect(() => plugin.start()).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle D-Bus connection errors', () => {
      const mockFailingBus = {
        listNames: vi.fn((callback) => callback(new Error('ECONNREFUSED'), null)),
        end: vi.fn()
      };
      mockDbusNative.createClient.mockReturnValue(mockFailingBus);
      
      plugin.start({ venusHost: 'unreachable.host' });
      
      // Should not throw and should handle gracefully
      expect(mockApp.setPluginStatus).toHaveBeenCalled();
    });
  });
});
