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

describe('VenusClient - Environment', () => {
  let client;
  let settings;

  beforeEach(() => {
    settings = {
      venusHost: 'test.local',
      productName: 'Test Environment',
      interval: 1000
    };
    
    client = new VenusClient(settings, 'environment');
    
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

  describe('Environment Instance Management', () => {
    it('should generate stable indices for environment paths', () => {
      const path1 = 'environment.water.temperature';
      const path2 = 'environment.water.temperature';
      const path3 = 'environment.air.temperature';
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      const index3 = client._generateStableIndex(path3);
      
      expect(index1).toBe(index2); // Same path should give same index
      expect(index1).not.toBe(index3); // Different path should give different index
      expect(index1).toBeGreaterThanOrEqual(0);
      expect(index1).toBeLessThan(1000);
    });

    it('should create new environment instance for new path', async () => {
      const path = 'environment.water.temperature';
      
      const instance = await client._getOrCreateEnvironmentInstance(path);
      
      expect(instance.basePath).toBe('environment.water');
      expect(instance.name).toBe('Water Temperature');
      expect(client.environmentInstances.has('environment.water')).toBe(true);
    });

    it('should extract correct base path from environment property paths', async () => {
      const paths = [
        'environment.water.temperature',
        'environment.water.humidity'
      ];
      
      const instances = await Promise.all(
        paths.map(path => client._getOrCreateEnvironmentInstance(path))
      );
      
      expect(instances[0]).toStrictEqual(instances[1]);
      expect(instances[0].basePath).toBe('environment.water');
    });
  });

  describe('Environment Name Generation', () => {
    it('should generate correct environment names', () => {
      expect(client._getEnvironmentName('environment.water.temperature')).toBe('Water Temperature');
      expect(client._getEnvironmentName('environment.air.temperature')).toBe('Air Temperature');
      expect(client._getEnvironmentName('environment.inside.humidity')).toBe('Inside Humidity');
      expect(client._getEnvironmentName('environment.outside.relativeHumidity')).toBe('Outside Humidity');
    });
  });

  describe('Signal K Update Handling', () => {
    it('should handle temperature updates correctly', async () => {
      const path = 'environment.water.temperature';
      const value = 293.15; // 20°C in Kelvin
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that an environment instance was created
      expect(client.environmentInstances.has('environment.water')).toBe(true);
      expect(client.environmentServices.has('environment.water')).toBe(true);
      
      // Check that the service was created
      const service = client.environmentServices.get('environment.water');
      expect(service).toBeDefined();
      expect(service.environmentData['/Temperature']).toBe(20); // Should be converted to Celsius
    });

    it('should handle temperature in Celsius correctly', async () => {
      const path = 'environment.air.temperature';
      const value = 22.5; // Already in Celsius
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that an environment instance was created
      expect(client.environmentInstances.has('environment.air')).toBe(true);
      expect(client.environmentServices.has('environment.air')).toBe(true);
      
      // Check that the service was created
      const service = client.environmentServices.get('environment.air');
      expect(service).toBeDefined();
      expect(service.environmentData['/Temperature']).toBe(22.5); // Should remain as Celsius
    });

    it('should handle humidity updates correctly', async () => {
      const path = 'environment.inside.humidity';
      const value = 0.65; // 65% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that an environment instance was created
      expect(client.environmentInstances.has('environment.inside')).toBe(true);
      expect(client.environmentServices.has('environment.inside')).toBe(true);
      
      // Check that the service was created
      const service = client.environmentServices.get('environment.inside');
      expect(service).toBeDefined();
      expect(service.environmentData['/Humidity']).toBe(65); // Should be converted to percentage
    });

    it('should handle relative humidity updates correctly', async () => {
      const path = 'environment.outside.relativeHumidity';
      const value = 0.45; // 45% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that an environment instance was created
      expect(client.environmentInstances.has('environment.outside')).toBe(true);
      expect(client.environmentServices.has('environment.outside')).toBe(true);
      
      // Check that the service was created
      const service = client.environmentServices.get('environment.outside');
      expect(service).toBeDefined();
      expect(service.environmentData['/Humidity']).toBe(45); // Should be converted to percentage
    });

    it('should skip invalid values', async () => {
      const path = 'environment.water.temperature';
      
      await client.handleSignalKUpdate(path, null);
      await client.handleSignalKUpdate(path, undefined);
      await client.handleSignalKUpdate(path, 'invalid');
      
      // Check that no instances were created for invalid values
      expect(client.environmentInstances.has('environment.water')).toBe(false);
      expect(client.environmentServices.has('environment.water')).toBe(false);
    });

    it('should emit dataUpdated events', async () => {
      const dataUpdatedSpy = vi.fn();
      client.on('dataUpdated', dataUpdatedSpy);
      
      const path = 'environment.water.temperature';
      const value = 293.15; // 20°C in Kelvin
      
      await client.handleSignalKUpdate(path, value);
      
      expect(dataUpdatedSpy).toHaveBeenCalledWith(
        'Environment Temperature',
        expect.stringContaining('20.0°C')
      );
    });

    it('should ignore unknown environment paths', async () => {
      const path = 'environment.water.unknownProperty';
      const value = 123;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that no instances were created for unknown properties
      expect(client.environmentInstances.has('environment.water')).toBe(false);
      expect(client.environmentServices.has('environment.water')).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect all environment services on disconnect', async () => {
      // Create some environment instances
      await client.handleSignalKUpdate('environment.water.temperature', 293.15);
      await client.handleSignalKUpdate('environment.air.temperature', 22.5);
      
      // Verify services were created
      expect(client.environmentServices.size).toBe(2);
      expect(client.environmentInstances.size).toBe(2);
      
      // Mock the disconnect method on services
      const waterService = client.environmentServices.get('environment.water');
      const airService = client.environmentServices.get('environment.air');
      
      if (waterService) vi.spyOn(waterService, 'disconnect').mockImplementation(() => {});
      if (airService) vi.spyOn(airService, 'disconnect').mockImplementation(() => {});
      
      await client.disconnect();
      
      // Verify all services were disconnected
      if (waterService) expect(waterService.disconnect).toHaveBeenCalled();
      if (airService) expect(airService.disconnect).toHaveBeenCalled();
      
      // Verify data structures were cleared
      expect(client.environmentInstances.size).toBe(0);
      expect(client.environmentServices.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
    });
  });
});
