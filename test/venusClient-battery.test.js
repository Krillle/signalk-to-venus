import { describe, it, beforeEach, expect, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';

// Mock dbus-native
const mockBus = {
  requestName: vi.fn(),
  exportInterface: vi.fn(),
  end: vi.fn(),
  invoke: vi.fn()
};

const mockDbusNative = {
  createClient: vi.fn(() => mockBus)
};

vi.mock('dbus-native', () => ({
  default: mockDbusNative
}));

describe('VenusClient - Battery', () => {
  let client;
  let settings;

  beforeEach(() => {
    settings = {
      venusHost: 'test.local',
      productName: 'Test Battery',
      interval: 1000
    };
    
    client = new VenusClient(settings, 'batteries');
    
    // Reset mocks and set up returns
    vi.clearAllMocks();
    mockDbusNative.createClient.mockReturnValue(mockBus);
    mockBus.requestName.mockImplementation((service, flags, callback) => {
      setTimeout(() => callback(null, 1), 0);
    });
    mockBus.exportInterface.mockImplementation(() => {});
    mockBus.end.mockImplementation(() => {});
    mockBus.invoke.mockImplementation((options, callback) => {
      // Mock Settings API response
      setTimeout(() => callback(null, []), 0);
    });
  });

  describe('Battery Instance Management', () => {
    it('should generate stable indices for battery paths', () => {
      const path1 = 'electrical.batteries.main';
      const path2 = 'electrical.batteries.main';
      const path3 = 'electrical.batteries.house';
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      const index3 = client._generateStableIndex(path3);
      
      expect(index1).toBe(index2); // Same path should give same index
      expect(index1).not.toBe(index3); // Different path should give different index
      expect(index1).toBeGreaterThanOrEqual(0);
      expect(index1).toBeLessThan(1000);
    });

    it('should create new battery instance for new path', async () => {
      const path = 'electrical.batteries.main.voltage';
      
      const instance = await client._getOrCreateBatteryInstance(path);
      
      expect(instance.basePath).toBe('electrical.batteries.main');
      expect(instance.name).toBe('Main Battery');
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(true);
    });

    it('should extract correct base path from battery property paths', async () => {
      const paths = [
        'electrical.batteries.main.voltage',
        'electrical.batteries.main.current',
        'electrical.batteries.main.capacity.stateOfCharge'
      ];
      
      const instances = await Promise.all(
        paths.map(path => client._getOrCreateBatteryInstance(path))
      );
      
      expect(instances[0]).toStrictEqual(instances[1]);
      expect(instances[1]).toStrictEqual(instances[2]);
      expect(instances[0].basePath).toBe('electrical.batteries.main');
    });
  });

  describe('Battery Name Generation', () => {
    it('should generate correct battery names', () => {
      expect(client._getBatteryName('electrical.batteries.main.voltage')).toBe('Main Battery');
      expect(client._getBatteryName('electrical.batteries.house.voltage')).toBe('House Battery');
      expect(client._getBatteryName('electrical.batteries.starter.voltage')).toBe('Starter Battery');
    });
  });

  describe('Signal K Update Handling', () => {
    it('should handle voltage updates correctly', async () => {
      const path = 'electrical.batteries.main.voltage';
      const value = 12.5;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a battery instance was created
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(true);
      expect(client.batteryServices.has('electrical.batteries.main')).toBe(true);
      
      // Check that the service was created
      const service = client.batteryServices.get('electrical.batteries.main');
      expect(service).toBeDefined();
      expect(service.batteryData['/Dc/0/Voltage']).toBe(12.5);
    });

    it('should handle current updates correctly', async () => {
      const path = 'electrical.batteries.main.current';
      const value = -5.2;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a battery instance was created
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(true);
      expect(client.batteryServices.has('electrical.batteries.main')).toBe(true);
      
      // Check that the service was created
      const service = client.batteryServices.get('electrical.batteries.main');
      expect(service).toBeDefined();
      expect(service.batteryData['/Dc/0/Current']).toBe(-5.2);
    });

    it('should handle state of charge updates correctly', async () => {
      const path = 'electrical.batteries.main.capacity.stateOfCharge';
      const value = 0.75; // 75% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a battery instance was created
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(true);
      expect(client.batteryServices.has('electrical.batteries.main')).toBe(true);
      
      // Check that the service was created
      const service = client.batteryServices.get('electrical.batteries.main');
      expect(service).toBeDefined();
      expect(service.batteryData['/Soc']).toBe(75); // Should be converted to percentage
    });

    it('should skip invalid values', async () => {
      const path = 'electrical.batteries.main.voltage';
      
      await client.handleSignalKUpdate(path, null);
      await client.handleSignalKUpdate(path, undefined);
      await client.handleSignalKUpdate(path, 'invalid');
      
      // Check that no instances were created for invalid values
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(false);
      expect(client.batteryServices.has('electrical.batteries.main')).toBe(false);
    });

    it('should emit dataUpdated events', async () => {
      const dataUpdatedSpy = vi.fn();
      client.on('dataUpdated', dataUpdatedSpy);
      
      const path = 'electrical.batteries.main.voltage';
      const value = 12.5;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(dataUpdatedSpy).toHaveBeenCalledWith(
        'Battery Voltage',
        expect.stringContaining('12.5V')
      );
    });

    it('should ignore unknown battery paths', async () => {
      const path = 'electrical.batteries.main.unknownProperty';
      const value = 123;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that no instances were created for unknown properties
      expect(client.batteryInstances.has('electrical.batteries.main')).toBe(false);
      expect(client.batteryServices.has('electrical.batteries.main')).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect all battery services on disconnect', async () => {
      // Create some battery instances
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.house.voltage', 12.3);
      
      // Verify services were created
      expect(client.batteryServices.size).toBe(2);
      expect(client.batteryInstances.size).toBe(2);
      
      // Mock the disconnect method on services
      const mainService = client.batteryServices.get('electrical.batteries.main');
      const houseService = client.batteryServices.get('electrical.batteries.house');
      
      if (mainService) vi.spyOn(mainService, 'disconnect').mockImplementation(() => {});
      if (houseService) vi.spyOn(houseService, 'disconnect').mockImplementation(() => {});
      
      await client.disconnect();
      
      // Verify all services were disconnected
      if (mainService) expect(mainService.disconnect).toHaveBeenCalled();
      if (houseService) expect(houseService.disconnect).toHaveBeenCalled();
      
      // Verify data structures were cleared
      expect(client.batteryInstances.size).toBe(0);
      expect(client.batteryServices.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
    });
  });
});
