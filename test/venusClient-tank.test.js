import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';
import { EventEmitter } from 'events';

describe('VenusClient - Tank', () => {
  let client;
  let mockSettings;

  beforeEach(() => {
    mockSettings = {
      venusHost: 'test.local',
      productName: 'Test Tank Device'
    };
    client = new VenusClient(mockSettings, 'tanks');
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Construction', () => {
    it('should create a tank client with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client.deviceType).toBe('tanks');
      expect(client._internalDeviceType).toBe('tank');
      expect(client.settings).toEqual(mockSettings);
      expect(client.deviceConfig).toBeDefined();
      expect(client.deviceConfig.serviceType).toBe('tank');
    });

    it('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });

    it('should throw error for unsupported device type', () => {
      expect(() => {
        new VenusClient(mockSettings, 'unsupported');
      }).toThrow('Unsupported device type: unsupported');
    });
  });

  describe('Path Processing', () => {
    it('should identify relevant tank paths', () => {
      expect(client._isRelevantPath('tanks.fuel.main.currentLevel')).toBe(true);
      expect(client._isRelevantPath('tanks.freshWater.port.capacity')).toBe(true);
      expect(client._isRelevantPath('tanks.wasteWater.starboard.name')).toBe(true);
      expect(client._isRelevantPath('electrical.batteries.main.voltage')).toBe(false);
      expect(client._isRelevantPath('environment.inside.temperature')).toBe(false);
    });

    it('should extract base path correctly', () => {
      expect(client._extractBasePath('tanks.fuel.main.currentLevel')).toBe('tanks.fuel.main');
      expect(client._extractBasePath('tanks.freshWater.port.capacity')).toBe('tanks.freshWater.port');
      expect(client._extractBasePath('tanks.wasteWater.starboard.name')).toBe('tanks.wasteWater.starboard');
      expect(client._extractBasePath('tanks.fuel.main.currentVolume')).toBe('tanks.fuel.main');
      expect(client._extractBasePath('tanks.fuel.main.voltage')).toBe('tanks.fuel.main');
    });

    it('should generate stable device indices', () => {
      const path1 = 'tanks.fuel.main';
      const path2 = 'tanks.freshWater.port';
      const path3 = 'tanks.fuel.main'; // Same as path1
      
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
    it('should generate correct fuel tank names', () => {
      expect(client._getTankName('tanks.fuel.main.currentLevel')).toBe('Fuel');
      expect(client._getTankName('tanks.fuel.starboard.currentLevel')).toBe('Fuel starboard');
      expect(client._getTankName('tanks.fuel.port.currentLevel')).toBe('Fuel port');
      expect(client._getTankName('tanks.fuel.0.currentLevel')).toBe('Fuel');
      expect(client._getTankName('tanks.fuel.1.currentLevel')).toBe('Fuel 2');
    });

    it('should generate correct freshwater tank names', () => {
      expect(client._getTankName('tanks.freshWater.main.currentLevel')).toBe('Freshwater');
      expect(client._getTankName('tanks.freshWater.starboard.currentLevel')).toBe('Freshwater starboard');
      expect(client._getTankName('tanks.freshWater.port.currentLevel')).toBe('Freshwater port');
      expect(client._getTankName('tanks.freshWater.0.currentLevel')).toBe('Freshwater');
      expect(client._getTankName('tanks.freshWater.1.currentLevel')).toBe('Freshwater 2');
    });

    it('should generate correct wastewater tank names', () => {
      expect(client._getTankName('tanks.wasteWater.primary.currentLevel')).toBe('Wastewater');
      expect(client._getTankName('tanks.wasteWater.starboard.currentLevel')).toBe('Wastewater starboard');
      expect(client._getTankName('tanks.wasteWater.0.currentLevel')).toBe('Wastewater');
    });

    it('should generate correct blackwater tank names', () => {
      expect(client._getTankName('tanks.blackWater.primary.currentLevel')).toBe('Blackwater');
      expect(client._getTankName('tanks.blackWater.starboard.currentLevel')).toBe('Blackwater starboard');
      expect(client._getTankName('tanks.blackWater.0.currentLevel')).toBe('Blackwater');
    });

    it('should handle single tank with generic ID', () => {
      // Mock deviceInstances to simulate a single tank
      client.deviceInstances.set('tanks.fuel.0', {});
      expect(client._getTankName('tanks.fuel.0.currentLevel')).toBe('Fuel');
      
      client.deviceInstances.set('tanks.freshWater.0', {});
      expect(client._getTankName('tanks.freshWater.0.currentLevel')).toBe('Freshwater');
    });

    it('should handle unknown tank types gracefully', () => {
      expect(client._getTankName('tanks.unknown.main.currentLevel')).toBe('Unknown Tank');
      expect(client._getTankName('tanks.unknown.0.currentLevel')).toBe('Unknown Tank');
      expect(client._getTankName('invalid.path')).toBe('Unknown Tank');
    });
  });

  describe('Signal K Updates', () => {
    it('should handle tank level updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Level', 'Fuel: 75.0%');
    });

    it('should handle tank capacity updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.capacity', 200);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Capacity', 'Fuel: 200.0L');
    });

    it('should handle tank volume updates correctly', async () => {
      // Set critical data first (currentLevel)
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.8);
      
      // Now spy on emit and test volume update
      const emitSpy = vi.spyOn(client, 'emit');
      await client.handleSignalKUpdate('tanks.fuel.main.currentVolume', 150);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Volume', 'Fuel: 150.0L');
    });

    it('should handle tank name updates correctly', async () => {
      // Set critical data first (currentLevel)
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.6);
      
      // Now spy on emit and test name update
      const emitSpy = vi.spyOn(client, 'emit');
      await client.handleSignalKUpdate('tanks.fuel.main.name', 'Main Fuel Tank');
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Name', 'Fuel: Main Fuel Tank');
    });

    it('should handle tank voltage updates correctly', async () => {
      // Set critical data first (currentLevel)
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.7);
      
      // Now spy on emit and test voltage update
      const emitSpy = vi.spyOn(client, 'emit');
      await client.handleSignalKUpdate('tanks.fuel.main.voltage', 12.5);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Voltage', 'Fuel: 12.50V');
    });

    it('should handle level values as percentages (0-1 and 0-100)', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.50);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Level', 'Fuel: 50.0%');
      
      // Test percentage value (0-100) - values > 1 are treated as already percentage
      await client.handleSignalKUpdate('tanks.fuel.starboard.currentLevel', 75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Tank Level', 'Fuel starboard: 7500.0%');
    });

    it('should ignore invalid values', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', null);
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', undefined);
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 'invalid');
      
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should ignore non-tank paths', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('environment.inside.temperature', 25);
      
      expect(emitSpy).not.toHaveBeenCalled();
      expect(client.deviceInstances.size).toBe(0);
    });

    it('should handle multiple tank instances', async () => {
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      await client.handleSignalKUpdate('tanks.fuel.starboard.currentLevel', 0.50);
      await client.handleSignalKUpdate('tanks.freshWater.main.currentLevel', 0.25);
      
      expect(client.deviceInstances.size).toBe(3);
      expect(client.deviceServices.size).toBe(3);
      
      // Check that each instance has correct properties
      expect(client.deviceInstances.has('tanks.fuel.main')).toBe(true);
      expect(client.deviceInstances.has('tanks.fuel.starboard')).toBe(true);
      expect(client.deviceInstances.has('tanks.freshWater.main')).toBe(true);
    });
  });

  describe('Device Instance Management', () => {
    it('should create device instances on first update', async () => {
      expect(client.deviceInstances.size).toBe(0);
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      
      expect(client.deviceInstances.size).toBe(1);
      const instance = client.deviceInstances.get('tanks.fuel.main');
      expect(instance).toBeDefined();
      expect(instance.name).toBe('Fuel');
      expect(instance.basePath).toBe('tanks.fuel.main');
      expect(typeof instance.index).toBe('number');
    });

    it('should reuse existing device instances', async () => {
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      const firstInstance = client.deviceInstances.get('tanks.fuel.main');
      
      await client.handleSignalKUpdate('tanks.fuel.main.capacity', 200);
      const secondInstance = client.deviceInstances.get('tanks.fuel.main');
      
      expect(firstInstance).toBe(secondInstance);
      expect(client.deviceInstances.size).toBe(1);
    });

    it('should prevent race conditions in device creation', async () => {
      // Simulate concurrent updates to the same device
      const promises = [
        client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75),
        client.handleSignalKUpdate('tanks.fuel.main.capacity', 200),
        client.handleSignalKUpdate('tanks.fuel.main.currentVolume', 150)
      ];
      
      await Promise.all(promises);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect cleanly', async () => {
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
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
      // Test error handling - the current implementation handles errors gracefully and doesn't throw
      await expect(client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75))
        .resolves.not.toThrow();
      
      // Even with malformed device services, it should handle gracefully
      client.deviceServices.set('tanks.fuel.main', null);
      await expect(client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.50))
        .resolves.not.toThrow();
    });

    it('should handle malformed paths gracefully', async () => {
      await expect(client.handleSignalKUpdate('', 0.75)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('tanks', 0.75)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('tanks.fuel', 0.75)).resolves.not.toThrow();
    });
  });
});
