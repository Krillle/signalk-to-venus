import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';
import { EventEmitter } from 'events';

describe('VenusClient - Environment', () => {
  let client;
  let mockSettings;

  beforeEach(() => {
    mockSettings = {
      venusHost: 'test.local',
      productName: 'Test Environment Device'
    };
    client = new VenusClient(mockSettings, 'environment');
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Construction', () => {
    it('should create an environment client with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client.deviceType).toBe('environment');
      expect(client._internalDeviceType).toBe('environment');
      expect(client.settings).toEqual(mockSettings);
      expect(client.deviceConfig).toBeDefined();
      expect(client.deviceConfig.serviceType).toBe('temperature');
    });

    it('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });
  });

  describe('Path Processing', () => {
    it('should identify relevant environment paths', () => {
      expect(client._isRelevantPath('environment.inside.temperature')).toBe(true);
      expect(client._isRelevantPath('environment.outside.temperature')).toBe(true);
      expect(client._isRelevantPath('environment.inside.humidity')).toBe(true);
      expect(client._isRelevantPath('environment.water.temperature')).toBe(true);
      expect(client._isRelevantPath('tanks.fuel.main.currentLevel')).toBe(false);
      expect(client._isRelevantPath('electrical.batteries.main.voltage')).toBe(false);
    });

    it('should extract base path correctly', () => {
      expect(client._extractBasePath('environment.inside.temperature')).toBe('environment.inside');
      expect(client._extractBasePath('environment.outside.temperature')).toBe('environment.outside');
      expect(client._extractBasePath('environment.inside.humidity')).toBe('environment.inside');
      expect(client._extractBasePath('environment.inside.relativeHumidity')).toBe('environment.inside');
      expect(client._extractBasePath('environment.water.temperature')).toBe('environment.water');
    });

    it('should generate stable device indices', () => {
      const path1 = 'environment.inside';
      const path2 = 'environment.outside';
      const path3 = 'environment.inside'; // Same as path1
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      const index3 = client._generateStableIndex(path3);
      
      expect(index1).toBe(index3); // Same path should give same index
      expect(index1).not.toBe(index2); // Different paths should give different indices
      expect(typeof index1).toBe('number');
      expect(index1).toBeGreaterThanOrEqual(0);
      expect(index1).toBeLessThan(1000);
    });
  });

  describe('Device Naming', () => {
    it('should generate correct environment sensor names', () => {
      expect(client._getEnvironmentName('environment.inside.temperature')).toBe('Inside Temperature');
      expect(client._getEnvironmentName('environment.outside.temperature')).toBe('Outside Temperature');
      expect(client._getEnvironmentName('environment.water.temperature')).toBe('Water Temperature');
      expect(client._getEnvironmentName('environment.air.temperature')).toBe('Air Temperature');
      expect(client._getEnvironmentName('environment.inside.humidity')).toBe('Inside Humidity');
      expect(client._getEnvironmentName('environment.outside.humidity')).toBe('Outside Humidity');
      expect(client._getEnvironmentName('environment.inside.relativeHumidity')).toBe('Inside Humidity');
    });

    it('should handle unknown environment types gracefully', () => {
      expect(client._getEnvironmentName('environment.unknown.temperature')).toBe('Unknown Temperature');
      expect(client._getEnvironmentName('environment.custom.customSensor')).toBe('Custom CustomSensor');
      expect(client._getEnvironmentName('invalid.path')).toBe('Environment sensor');
    });
  });

  describe('Signal K Updates', () => {
    it('should handle temperature updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Temperature', 'Inside Temperature: 25.5°C');
    });

    it('should handle humidity updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('environment.inside.humidity', 0.65);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Humidity', 'Inside Humidity: 65.0%');
    });

    it('should handle relative humidity updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('environment.inside.relativeHumidity', 0.72);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Humidity', 'Inside Humidity: 72.0%');
    });

    it('should handle temperature conversion from Kelvin', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test Celsius temperature (below 200, should not convert)
      await client.handleSignalKUpdate('environment.inside.temperature', 25);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Temperature', 'Inside Temperature: 25.0°C');
      
      // Test Kelvin temperature (above 200, should convert)
      await client.handleSignalKUpdate('environment.outside.temperature', 298.15);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Temperature', 'Outside temperature: 25.0°C');
    });

    it('should handle humidity values as percentages (0-1 and 0-100)', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('environment.inside.humidity', 0.50);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Humidity', 'Inside Humidity: 50.0%');
      
      // Test percentage value (0-100)
      await client.handleSignalKUpdate('environment.outside.humidity', 75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Environment Humidity', 'Outside humidity: 75.0%');
    });

    it('should ignore invalid values', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('environment.inside.temperature', null);
      await client.handleSignalKUpdate('environment.inside.temperature', undefined);
      await client.handleSignalKUpdate('environment.inside.temperature', 'invalid');
      
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should ignore non-environment paths', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      expect(emitSpy).not.toHaveBeenCalled();
      expect(client.deviceInstances.size).toBe(0);
    });

    it('should handle multiple environment instances', async () => {
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      await client.handleSignalKUpdate('environment.outside.temperature', 18.2);
      await client.handleSignalKUpdate('environment.water.temperature', 12.8);
      await client.handleSignalKUpdate('environment.inside.humidity', 0.65);
      
      expect(client.deviceInstances.size).toBe(3); // inside, outside, water
      expect(client.deviceServices.size).toBe(3);
      
      // Check that each instance has correct properties
      expect(client.deviceInstances.has('environment.inside')).toBe(true);
      expect(client.deviceInstances.has('environment.outside')).toBe(true);
      expect(client.deviceInstances.has('environment.water')).toBe(true);
    });

    it('should handle multiple sensors for same environment', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      await client.handleSignalKUpdate('environment.inside.humidity', 0.65);
      
      expect(client.deviceInstances.size).toBe(1); // Only one instance for inside
      expect(client.deviceServices.size).toBe(1);
      expect(emitSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Device Instance Management', () => {
    it('should create device instances on first update', async () => {
      expect(client.deviceInstances.size).toBe(0);
      
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      
      expect(client.deviceInstances.size).toBe(1);
      const instance = client.deviceInstances.get('environment.inside');
      expect(instance).toBeDefined();
      expect(instance.name).toBe('Inside Temperature');
      expect(instance.basePath).toBe('environment.inside');
      expect(typeof instance.index).toBe('number');
    });

    it('should reuse existing device instances', async () => {
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      const firstInstance = client.deviceInstances.get('environment.inside');
      
      await client.handleSignalKUpdate('environment.inside.humidity', 0.65);
      const secondInstance = client.deviceInstances.get('environment.inside');
      
      expect(firstInstance).toBe(secondInstance);
      expect(client.deviceInstances.size).toBe(1);
    });

    it('should prevent race conditions in device creation', async () => {
      // Simulate concurrent updates to the same device
      const promises = [
        client.handleSignalKUpdate('environment.inside.temperature', 25.5),
        client.handleSignalKUpdate('environment.inside.humidity', 0.65),
        client.handleSignalKUpdate('environment.inside.relativeHumidity', 0.70)
      ];
      
      await Promise.all(promises);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect cleanly', async () => {
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      expect(client.deviceInstances.size).toBe(1);
      
      await client.disconnect();
      
      expect(client.deviceInstances.size).toBe(0);
      expect(client.deviceServices.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
      expect(client.bus).toBeNull();
    });

    it('should handle disconnect with no active connections', async () => {
      await expect(client.disconnect()).resolves.not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully during updates', async () => {
      // Mock a device service that throws an error
      const mockDeviceService = {
        updateProperty: vi.fn().mockRejectedValue(new Error('D-Bus error'))
      };
      
      await client.handleSignalKUpdate('environment.inside.temperature', 25.5);
      client.deviceServices.set('environment.inside', mockDeviceService);
      
      await expect(client.handleSignalKUpdate('environment.inside.temperature', 26.0))
        .rejects.toThrow('D-Bus error');
    });

    it('should handle malformed paths gracefully', async () => {
      await expect(client.handleSignalKUpdate('', 25.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('environment', 25.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('environment.inside', 25.5)).resolves.not.toThrow();
    });
  });
});
