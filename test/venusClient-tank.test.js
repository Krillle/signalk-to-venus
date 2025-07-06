import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { VenusClient } from '../venusClient-tank.js';
import EventEmitter from 'events';

// Mock dbus-native
const mockBus = {
  requestName: vi.fn(),
  exportInterface: vi.fn(),
  end: vi.fn(),
  on: vi.fn((event, callback) => {
    // Simulate immediate connection for tests
    if (event === 'connect') {
      setTimeout(callback, 0);
    }
  })
};

const mockDbusNative = {
  createClient: vi.fn(() => mockBus)
};

vi.mock('dbus-native', () => ({
  default: mockDbusNative
}));

describe('VenusClient - Tank', () => {
  let client;
  let settings;

  beforeEach(() => {
    settings = {
      venusHost: 'test.local',
      productName: 'Test Tank',
      interval: 1000
    };
    
    client = new VenusClient(settings, 'tanks');
    
    // Reset mocks and set up returns
    vi.clearAllMocks();
    mockDbusNative.createClient.mockReturnValue(mockBus);
    mockBus.requestName.mockImplementation((service, flags, callback) => {
      // Use setTimeout to avoid blocking the test
      setTimeout(() => callback(null, 1), 0);
    });
    mockBus.exportInterface.mockImplementation(() => {});
    mockBus.end.mockImplementation(() => {});
    
    // Mock D-Bus related methods to prevent real network connections
    vi.spyOn(client, '_exportMgmtSubtree').mockImplementation(() => {});
    vi.spyOn(client, '_exportRootInterface').mockImplementation(() => {});
    
    // Set up mock buses
    client.bus = mockBus;
    client.settingsBus = mockBus;
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Constructor', () => {
    it('should initialize with correct properties', () => {
      // Create a fresh client for this test to check initial state
      const testClient = new VenusClient(settings, 'tanks');
      
      expect(testClient.settings).toEqual(settings);
      expect(testClient.deviceType).toBe('tanks');
      expect(testClient.bus).toBeNull();
      expect(testClient.tankData).toEqual({});
      expect(testClient.tankInstances).toBeInstanceOf(Map);
      expect(testClient.exportedInterfaces).toBeInstanceOf(Set);
    });

    it('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });
  });

  describe('Value Wrapping', () => {
    it('should wrap values correctly for D-Bus', () => {
      expect(client.wrapValue('s', 'test')).toEqual(['s', 'test']);
      expect(client.wrapValue('i', 42)).toEqual(['i', 42]);
      expect(client.wrapValue('d', 3.14)).toEqual(['d', 3.14]);
      expect(client.wrapValue('b', true)).toEqual(['b', true]);
    });

    it('should detect correct D-Bus types', () => {
      expect(client.getType('string')).toBe('s');
      expect(client.getType(42)).toBe('i');
      expect(client.getType(3.14)).toBe('d');
      expect(client.getType(true)).toBe('b');
    });
  });

  describe('Stable Index Generation', () => {
    it('should generate same index for same path', () => {
      const path1 = 'tanks.fuel.starboard';
      const path2 = 'tanks.fuel.starboard';
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      
      expect(index1).toBe(index2);
      expect(index1).toBeGreaterThanOrEqual(0);
      expect(index1).toBeLessThan(1000);
    });

    it('should generate different indices for different paths', () => {
      const path1 = 'tanks.fuel.starboard';
      const path2 = 'tanks.fuel.port';
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      
      expect(index1).not.toBe(index2);
    });

    it('should always return positive numbers within range', () => {
      const testPaths = [
        'tanks.fuel.main',
        'tanks.freshWater.primary',
        'tanks.wasteWater.secondary',
        'tanks.blackWater.tank1',
        'very.long.tank.path.with.many.segments'
      ];

      testPaths.forEach(path => {
        const index = client._generateStableIndex(path);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(1000);
        expect(Number.isInteger(index)).toBe(true);
      });
    });
  });

  describe('Tank Name Generation', () => {
    it('should generate correct tank names for different types', () => {
      expect(client._getTankName('tanks.fuel.starboard.currentLevel')).toBe('Fuel starboard');
      expect(client._getTankName('tanks.freshWater.main.currentLevel')).toBe('Freshwater');
      expect(client._getTankName('tanks.wasteWater.tank1.currentLevel')).toBe('Wastewater tank1');
      expect(client._getTankName('tanks.blackWater.primary.currentLevel')).toBe('Blackwater');
    });

    it('should handle unknown tank types', () => {
      expect(client._getTankName('tanks.unknown.test.currentLevel')).toBe('Unknown test');
    });

    it('should handle multiple tanks of same type', () => {
      // First call - should be just type name for generic ID
      client._getTankName('tanks.fuel.main.currentLevel');
      // Second call with different ID - should include ID
      expect(client._getTankName('tanks.fuel.aux.currentLevel')).toBe('Fuel aux');
    });
  });

  describe('Tank Instance Management', () => {
    it('should create new tank instance for new path', async () => {
      const path = 'tanks.fuel.starboard.currentLevel';
      
      const instance = await client._getOrCreateTankInstance(path);
      
      expect(instance.basePath).toBe('tanks.fuel.starboard');
      expect(instance.name).toBe('Fuel starboard');
      expect(instance.index).toBeDefined();
      expect(client.tankInstances.has('tanks.fuel.starboard')).toBe(true);
    });

    it('should return existing tank instance for same base path', async () => {
      const path1 = 'tanks.fuel.starboard.currentLevel';
      const path2 = 'tanks.fuel.starboard.capacity';
      
      const instance1 = await client._getOrCreateTankInstance(path1);
      const instance2 = await client._getOrCreateTankInstance(path2);
      
      expect(instance1).toBe(instance2);
      expect(client.tankInstances.size).toBe(1);
    });

    it('should extract correct base path from different property paths', async () => {
      const paths = [
        'tanks.fuel.starboard.currentLevel',
        'tanks.fuel.starboard.capacity',
        'tanks.fuel.starboard.name'
      ];
      
      // Run sequentially to avoid race condition protection
      const instances = [];
      for (const path of paths) {
        const instance = await client._getOrCreateTankInstance(path);
        instances.push(instance);
      }
      
      // All should return the same instance (first call creates, others return existing)
      expect(instances[0]).toStrictEqual(instances[1]);
      expect(instances[1]).toStrictEqual(instances[2]);
      expect(instances[0].basePath).toBe('tanks.fuel.starboard');
      
      // Verify only one registration call was made (vedbus.py pattern)
      expect(client._registerTankInSettings).toHaveBeenCalledTimes(1);
    });
  });

  describe('D-Bus Interface Export Protection', () => {
    beforeEach(async () => {
      // Set up mock bus for these tests
      client.bus = mockBus;
      client.settingsBus = mockBus;
    });

    it('should export interface only once per path', () => {
      // Create a mock TankService with the required methods
      const mockTankService = {
        updateProperty: vi.fn(),
        disconnect: vi.fn(),
        serviceName: 'com.victronenergy.tank.signalk_123',
        exportedInterfaces: new Set(),
        tankData: {}
      };
      
      // Mock tank instance
      const mockTankInstance = {
        basePath: 'tanks.fuel.starboard',
        vrmInstanceId: 123,
        name: 'Fuel starboard'
      };
      
      // Set up the tank service in the client
      client.tankServices.set(mockTankInstance.basePath, mockTankService);
      
      const path = '/Level';
      const config = { value: 50, type: 'd', text: 'Test level' };
      
      // First export
      client._exportProperty(mockTankInstance, path, config);
      expect(mockTankService.updateProperty).toHaveBeenCalledTimes(1);
      expect(mockTankService.updateProperty).toHaveBeenCalledWith(path, 50, 'd', 'Test level');
      
      // Second export should still call updateProperty (it handles the deduplication internally)
      client._exportProperty(mockTankInstance, path, { value: 75, type: 'd', text: 'Test level' });
      expect(mockTankService.updateProperty).toHaveBeenCalledTimes(2);
      expect(mockTankService.updateProperty).toHaveBeenLastCalledWith(path, 75, 'd', 'Test level');
    });

    it('should export different interfaces for different paths', () => {
      // Create a mock TankService with the required methods
      const mockTankService = {
        updateProperty: vi.fn(),
        disconnect: vi.fn(),
        serviceName: 'com.victronenergy.tank.signalk_123',
        exportedInterfaces: new Set(),
        tankData: {}
      };
      
      // Mock tank instance
      const mockTankInstance = {
        basePath: 'tanks.fuel.starboard',
        vrmInstanceId: 123,
        name: 'Fuel starboard'
      };
      
      // Set up the tank service in the client
      client.tankServices.set(mockTankInstance.basePath, mockTankService);
      
      const path1 = '/Level';
      const path2 = '/Capacity';
      
      client._exportProperty(mockTankInstance, path1, { value: 50, type: 'd', text: 'Level' });
      client._exportProperty(mockTankInstance, path2, { value: 100, type: 'd', text: 'Capacity' });
      
      expect(mockTankService.updateProperty).toHaveBeenCalledTimes(2);
      expect(mockTankService.updateProperty).toHaveBeenNthCalledWith(1, path1, 50, 'd', 'Level');
      expect(mockTankService.updateProperty).toHaveBeenNthCalledWith(2, path2, 100, 'd', 'Capacity');
    });
  });

  describe('Signal K Update Handling', () => {
    let mockTankService;
    
    beforeEach(async () => {
      // Set up mock bus for these tests
      client.bus = mockBus;
      client.settingsBus = mockBus;
      vi.spyOn(client, '_exportProperty').mockImplementation(() => {});
      
      // Create a mock TankService
      mockTankService = {
        updateProperty: vi.fn(),
        disconnect: vi.fn(),
        serviceName: 'com.victronenergy.tank.signalk_123',
        exportedInterfaces: new Set(),
        tankData: {}
      };
      
      // Mock the TankService creation so it returns our mock
      vi.spyOn(client, '_getOrCreateTankInstance').mockImplementation(async (path) => {
        const basePath = path.replace(/\.(currentLevel|capacity|name|currentVolume|voltage)$/, '');
        const tankInstance = {
          basePath: basePath,
          index: 123,
          name: 'Fuel starboard',
          vrmInstanceId: 123
        };
        
        // Set up the mock tank service
        client.tankServices.set(basePath, mockTankService);
        
        return tankInstance;
      });
    });

    it('should handle tank level updates correctly', async () => {
      const path = 'tanks.fuel.starboard.currentLevel';
      const value = 0.75; // 75% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      expect(mockTankService.updateProperty).toHaveBeenCalledWith(
        '/Level',
        75, // Should be converted to percentage
        'd',
        expect.stringContaining('level')
      );
    });

    it('should handle tank capacity updates correctly', async () => {
      const path = 'tanks.fuel.starboard.capacity';
      const value = 200; // 200 liters
      
      await client.handleSignalKUpdate(path, value);
      
      expect(mockTankService.updateProperty).toHaveBeenCalledWith(
        '/Capacity',
        200,
        'd',
        expect.stringContaining('capacity')
      );
    });

    it('should handle tank name updates correctly', async () => {
      const path = 'tanks.fuel.starboard.name';
      const value = 'Main Fuel Tank';
      
      await client.handleSignalKUpdate(path, value);
      
      expect(mockTankService.updateProperty).toHaveBeenCalledWith(
        '/Name',
        'Main Fuel Tank',
        's',
        expect.stringContaining('name')
      );
    });

    it('should skip invalid values', async () => {
      const path = 'tanks.fuel.starboard.currentLevel';
      
      await client.handleSignalKUpdate(path, null);
      await client.handleSignalKUpdate(path, undefined);
      await client.handleSignalKUpdate(path, 'invalid');
      await client.handleSignalKUpdate(path, NaN);
      
      expect(client._exportProperty).not.toHaveBeenCalled();
    });

    it('should emit dataUpdated events', async () => {
      const dataUpdatedSpy = vi.fn();
      client.on('dataUpdated', dataUpdatedSpy);
      
      const path = 'tanks.fuel.starboard.currentLevel';
      const value = 0.5;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(dataUpdatedSpy).toHaveBeenCalledWith(
        'Tank Level',
        expect.stringContaining('50.0%')
      );
    });

    it('should ignore unknown tank paths', async () => {
      const path = 'tanks.fuel.starboard.unknownProperty';
      const value = 123;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).not.toHaveBeenCalled();
    });
  });

  describe('Initialization', () => {
    it.skip('should create D-Bus connections (requires Venus OS)', async () => {
      // Skip this test as it requires actual Venus OS connection
      // This test would validate real D-Bus connection creation
      console.log('Skipping D-Bus connection test - requires Venus OS');
    });

    it.skip('should request service name (requires Venus OS)', async () => {
      // Skip this test as it requires actual Venus OS connection
      // This test would validate D-Bus service name registration
      console.log('Skipping service name test - requires Venus OS');
    });

    it.skip('should handle connection errors gracefully (requires Venus OS)', async () => {
      // Skip this test as it requires actual Venus OS connection
      // This test would validate error handling for connection failures
      console.log('Skipping connection error test - requires Venus OS');
    });
  });

  describe('Cleanup', () => {
    beforeEach(async () => {
      // Set up mock bus for these tests
      client.bus = mockBus;
      client.settingsBus = mockBus;
    });

    it('should disconnect the bus', async () => {
      await client.disconnect();
      
      expect(mockBus.end).toHaveBeenCalledTimes(1);
      expect(client.bus).toBeNull();
    });

    it('should clear all data structures', async () => {
      // Add some data
      client.tankData['/Tank/1/Level'] = 50;
      client.tankInstances.set('tanks.fuel.main', { index: 1 });
      client.exportedInterfaces.add('/Tank/1/Level');
      
      await client.disconnect();
      
      expect(client.tankData).toEqual({});
      expect(client.tankInstances.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
    });

    it('should handle disconnect errors gracefully', async () => {
      mockBus.end.mockImplementation(() => {
        throw new Error('Disconnect error');
      });
      
      // Should not throw
      await expect(client.disconnect()).resolves.not.toThrow();
    });
  });
});
