import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';
import { EventEmitter } from 'events';

describe('VenusClient - Battery', () => {
  let client;
  let mockSettings;

  beforeEach(() => {
    mockSettings = {
      venusHost: 'test.local',
      productName: 'Test Battery Device'
    };
    client = new VenusClient(mockSettings, 'batteries');
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Construction', () => {
    it('should create a battery client with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client.deviceType).toBe('batteries');
      expect(client._internalDeviceType).toBe('battery');
      expect(client.settings).toEqual(mockSettings);
      expect(client.deviceConfig).toBeDefined();
      expect(client.deviceConfig.serviceType).toBe('battery');
    });

    it('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });
  });

  describe('Path Processing', () => {
    it('should identify relevant battery paths', () => {
      expect(client._isRelevantPath('electrical.batteries.main.voltage')).toBe(true);
      expect(client._isRelevantPath('electrical.batteries.house.current')).toBe(true);
      expect(client._isRelevantPath('electrical.batteries.starter.stateOfCharge')).toBe(true);
      expect(client._isRelevantPath('tanks.fuel.main.currentLevel')).toBe(false);
      expect(client._isRelevantPath('environment.inside.temperature')).toBe(false);
    });

    it('should extract base path correctly', () => {
      expect(client._extractBasePath('electrical.batteries.main.voltage')).toBe('electrical.batteries.main');
      expect(client._extractBasePath('electrical.batteries.house.current')).toBe('electrical.batteries.house');
      expect(client._extractBasePath('electrical.batteries.starter.stateOfCharge')).toBe('electrical.batteries.starter');
      expect(client._extractBasePath('electrical.batteries.main.capacity.stateOfCharge')).toBe('electrical.batteries.main');
      expect(client._extractBasePath('electrical.batteries.main.power')).toBe('electrical.batteries.main');
    });

    it('should generate stable device indices', () => {
      const path1 = 'electrical.batteries.main';
      const path2 = 'electrical.batteries.house';
      const path3 = 'electrical.batteries.main'; // Same as path1
      
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
    it('should generate correct battery names', () => {
      expect(client._getBatteryName('electrical.batteries.main.voltage')).toBe('Main Battery');
      expect(client._getBatteryName('electrical.batteries.house.current')).toBe('House Battery');
      expect(client._getBatteryName('electrical.batteries.starter.stateOfCharge')).toBe('Starter Battery');
    });

    it('should handle unknown battery types gracefully', () => {
      expect(client._getBatteryName('electrical.batteries.unknown.voltage')).toBe('Unknown Battery');
      expect(client._getBatteryName('invalid.path')).toBe('Unknown Battery');
    });
  });

  describe('Signal K Updates', () => {
    it('should handle battery voltage updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Voltage', 'Main Battery: 12.50V');
    });

    it('should handle battery current updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.2);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Current', 'Main Battery: 5.2A');
    });

    it('should handle battery power updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.power', 65);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Power', 'Main Battery: 65.0W');
    });

    it('should handle battery state of charge updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.85);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Main Battery: 85.0%');
    });

    it('should handle battery capacity state of charge updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.capacity.stateOfCharge', 0.75);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Main Battery: 75.0%');
    });

    it('should handle battery temperature updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test Celsius temperature
      await client.handleSignalKUpdate('electrical.batteries.main.temperature', 25);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Temperature', 'Main Battery: 25.0°C');
      
      // Test Kelvin temperature (should be converted)
      await client.handleSignalKUpdate('electrical.batteries.house.temperature', 298.15);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Temperature', 'House Battery: 25.0°C');
    });

    it('should handle SoC values as percentages (0-1 and 0-100)', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.50);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Main Battery: 50.0%');
      
      // Test percentage value (0-100)
      await client.handleSignalKUpdate('electrical.batteries.house.stateOfCharge', 75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'House Battery: 75.0%');
    });

    it('should ignore invalid values', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', null);
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', undefined);
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 'invalid');
      
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should ignore non-battery paths', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      await client.handleSignalKUpdate('environment.inside.temperature', 25);
      
      expect(emitSpy).not.toHaveBeenCalled();
      expect(client.deviceInstances.size).toBe(0);
    });

    it('should handle multiple battery instances', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.house.voltage', 12.8);
      await client.handleSignalKUpdate('electrical.batteries.starter.voltage', 12.2);
      
      expect(client.deviceInstances.size).toBe(3);
      expect(client.deviceServices.size).toBe(3);
      
      // Check that each instance has correct properties
      expect(client.deviceInstances.has('electrical.batteries.main')).toBe(true);
      expect(client.deviceInstances.has('electrical.batteries.house')).toBe(true);
      expect(client.deviceInstances.has('electrical.batteries.starter')).toBe(true);
    });
  });

  describe('Device Instance Management', () => {
    it('should create device instances on first update', async () => {
      expect(client.deviceInstances.size).toBe(0);
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      expect(client.deviceInstances.size).toBe(1);
      const instance = client.deviceInstances.get('electrical.batteries.main');
      expect(instance).toBeDefined();
      expect(instance.name).toBe('Main Battery');
      expect(instance.basePath).toBe('electrical.batteries.main');
      expect(typeof instance.index).toBe('number');
    });

    it('should reuse existing device instances', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      const firstInstance = client.deviceInstances.get('electrical.batteries.main');
      
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.2);
      const secondInstance = client.deviceInstances.get('electrical.batteries.main');
      
      expect(firstInstance).toBe(secondInstance);
      expect(client.deviceInstances.size).toBe(1);
    });

    it('should prevent race conditions in device creation', async () => {
      // Simulate concurrent updates to the same device
      const promises = [
        client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5),
        client.handleSignalKUpdate('electrical.batteries.main.current', 5.2),
        client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.85)
      ];
      
      await Promise.all(promises);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect cleanly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
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
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      client.deviceServices.set('electrical.batteries.main', mockDeviceService);
      
      await expect(client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.8))
        .rejects.toThrow('D-Bus error');
    });

    it('should handle malformed paths gracefully', async () => {
      await expect(client.handleSignalKUpdate('', 12.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical', 12.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical.batteries', 12.5)).resolves.not.toThrow();
    });
  });
});
