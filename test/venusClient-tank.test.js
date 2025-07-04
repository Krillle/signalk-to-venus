import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { VenusClient } from '../venusClient-tank.js';
import EventEmitter from 'events';

// Mock dbus-native
const mockBus = {
  requestName: vi.fn(),
  exportInterface: vi.fn(),
  end: vi.fn()
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
    
    // Mock init to prevent real network connections
    vi.spyOn(client, 'init').mockResolvedValue();
    
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
      expect(client.settings).toEqual(settings);
      expect(client.deviceType).toBe('tanks');
      expect(client.bus).toBeNull();
      expect(client.tankData).toEqual({});
      expect(client.tankInstances).toBeInstanceOf(Map);
      expect(client.exportedInterfaces).toBeInstanceOf(Set);
      expect(client.VBUS_SERVICE).toBe('com.victronenergy.virtual.tanks');
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
      
      // Mock settings registration
      vi.spyOn(client, '_registerTankInSettings').mockResolvedValue(123);
      
      const instance = await client._getOrCreateTankInstance(path);
      
      expect(instance.basePath).toBe('tanks.fuel.starboard');
      expect(instance.name).toBe('Fuel starboard');
      expect(instance.vrmInstanceId).toBe(123);
      expect(client.tankInstances.has('tanks.fuel.starboard')).toBe(true);
    });

    it('should return existing tank instance for same base path', async () => {
      const path1 = 'tanks.fuel.starboard.currentLevel';
      const path2 = 'tanks.fuel.starboard.capacity';
      
      vi.spyOn(client, '_registerTankInSettings').mockResolvedValue(123);
      
      const instance1 = await client._getOrCreateTankInstance(path1);
      const instance2 = await client._getOrCreateTankInstance(path2);
      
      expect(instance1).toBe(instance2);
      expect(client._registerTankInSettings).toHaveBeenCalledTimes(1);
    });

    it('should extract correct base path from different property paths', async () => {
      vi.spyOn(client, '_registerTankInSettings').mockResolvedValue(123);
      
      const paths = [
        'tanks.fuel.starboard.currentLevel',
        'tanks.fuel.starboard.capacity',
        'tanks.fuel.starboard.name'
      ];
      
      const instances = await Promise.all(
        paths.map(path => client._getOrCreateTankInstance(path))
      );
      
      // All should return the same instance
      expect(instances[0]).toBe(instances[1]);
      expect(instances[1]).toStrictEqual(instances[2]);
      expect(instances[0].basePath).toBe('tanks.fuel.starboard');
    });
  });

  describe('D-Bus Interface Export Protection', () => {
    beforeEach(async () => {
      // Mock the init method to avoid actual network connections
      vi.spyOn(client, 'init').mockResolvedValue();
      client.bus = mockBus;
      client.settingsBus = mockBus;
    });

    it('should export interface only once per path', () => {
      const path = '/Tank/1/Level';
      const config = { value: 50, type: 'd', text: 'Test level' };
      
      // First export
      client._exportProperty(path, config);
      expect(mockBus.exportInterface).toHaveBeenCalledTimes(1);
      expect(client.exportedInterfaces.has(path)).toBe(true);
      
      // Second export should not call exportInterface again
      client._exportProperty(path, { value: 75, type: 'd', text: 'Test level' });
      expect(mockBus.exportInterface).toHaveBeenCalledTimes(1);
      expect(client.tankData[path]).toBe(75); // Value should be updated
    });

    it('should export different interfaces for different paths', () => {
      const path1 = '/Tank/1/Level';
      const path2 = '/Tank/1/Capacity';
      
      client._exportProperty(path1, { value: 50, type: 'd', text: 'Level' });
      client._exportProperty(path2, { value: 100, type: 'd', text: 'Capacity' });
      
      expect(mockBus.exportInterface).toHaveBeenCalledTimes(2);
      expect(client.exportedInterfaces.has(path1)).toBe(true);
      expect(client.exportedInterfaces.has(path2)).toBe(true);
    });
  });

  describe('Signal K Update Handling', () => {
    beforeEach(async () => {
      // Mock the init method to avoid actual network connections
      vi.spyOn(client, 'init').mockResolvedValue();
      client.bus = mockBus;
      client.settingsBus = mockBus;
      vi.spyOn(client, '_registerTankInSettings').mockResolvedValue(123);
      vi.spyOn(client, '_exportProperty').mockImplementation(() => {});
    });

    it('should handle tank level updates correctly', async () => {
      const path = 'tanks.fuel.starboard.currentLevel';
      const value = 0.75; // 75% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Tank/123/Level',
        expect.objectContaining({
          value: 75, // Should be converted to percentage
          type: 'd',
          text: expect.stringContaining('level')
        })
      );
    });

    it('should handle tank capacity updates correctly', async () => {
      const path = 'tanks.fuel.starboard.capacity';
      const value = 200; // 200 liters
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Tank/123/Capacity',
        expect.objectContaining({
          value: 200,
          type: 'd',
          text: expect.stringContaining('capacity')
        })
      );
    });

    it('should handle tank name updates correctly', async () => {
      const path = 'tanks.fuel.starboard.name';
      const value = 'Main Fuel Tank';
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Tank/123/Name',
        expect.objectContaining({
          value: 'Main Fuel Tank',
          type: 's',
          text: expect.stringContaining('name')
        })
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
    beforeEach(() => {
      // Restore the real init method for initialization tests
      vi.restoreAllMocks();
      
      // Re-setup basic mocks but leave init unmocked
      mockDbusNative.createClient.mockReturnValue(mockBus);
      mockBus.requestName.mockImplementation((service, flags, callback) => {
        setTimeout(() => callback(null, 1), 0);
      });
      mockBus.exportInterface.mockImplementation(() => {});
      mockBus.end.mockImplementation(() => {});
    });
    
    it('should create D-Bus connections', async () => {
      await client.init();
      
      expect(mockDbusNative.createClient).toHaveBeenCalledTimes(2);
      expect(mockDbusNative.createClient).toHaveBeenCalledWith({
        host: 'test.local',
        port: 78,
        authMethods: ['ANONYMOUS']
      });
    });

    it('should request service name', async () => {
      await client.init();
      
      expect(mockBus.requestName).toHaveBeenCalledWith(
        'com.victronenergy.virtual.tanks',
        0,
        expect.any(Function)
      );
    });

    it('should handle connection errors gracefully', async () => {
      mockBus.requestName.mockImplementation((service, flags, callback) => {
        setTimeout(() => callback(new Error('ECONNREFUSED')), 0);
      });
      
      await expect(client.init()).rejects.toThrow('Cannot connect to Venus OS');
    });
  });

  describe('Cleanup', () => {
    beforeEach(async () => {
      // Mock the init method to avoid actual network connections
      vi.spyOn(client, 'init').mockResolvedValue();
      client.bus = mockBus;
      client.settingsBus = mockBus;
    });

    it('should disconnect both buses', async () => {
      await client.disconnect();
      
      expect(mockBus.end).toHaveBeenCalledTimes(2);
      expect(client.bus).toBeNull();
      expect(client.settingsBus).toBeNull();
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
