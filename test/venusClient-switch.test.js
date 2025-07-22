import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';
import { EventEmitter } from 'events';

describe('VenusClient - Switch', () => {
  let client;
  let mockSettings;

  beforeEach(() => {
    mockSettings = {
      venusHost: 'test.local',
      productName: 'Test Switch Device'
    };
    client = new VenusClient(mockSettings, 'switches');
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
    }
  });

  describe('Construction', () => {
    it('should create a switch client with correct configuration', () => {
      expect(client).toBeDefined();
      expect(client.deviceType).toBe('switches');
      expect(client._internalDeviceType).toBe('switch');
      expect(client.settings).toEqual(mockSettings);
      expect(client.deviceConfig).toBeDefined();
      expect(client.deviceConfig.serviceType).toBe('switch');
    });

    it('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });
  });

  describe('Path Processing', () => {
    it('should identify relevant switch paths', () => {
      expect(client._isRelevantPath('electrical.switches.nav.state')).toBe(true);
      expect(client._isRelevantPath('electrical.switches.anchor.state')).toBe(true);
      expect(client._isRelevantPath('electrical.switches.cabinLights.dimmingLevel')).toBe(true);
      expect(client._isRelevantPath('tanks.fuel.main.currentLevel')).toBe(false);
      expect(client._isRelevantPath('environment.inside.temperature')).toBe(false);
    });

    it('should extract base path correctly', () => {
      expect(client._extractBasePath('electrical.switches.nav.state')).toBe('electrical.switches.nav');
      expect(client._extractBasePath('electrical.switches.anchor.state')).toBe('electrical.switches.anchor');
      expect(client._extractBasePath('electrical.switches.cabinLights.dimmingLevel')).toBe('electrical.switches.cabinLights');
      expect(client._extractBasePath('electrical.switches.nav.position')).toBe('electrical.switches.nav');
      expect(client._extractBasePath('electrical.switches.nav.name')).toBe('electrical.switches.nav');
    });

    it('should generate stable device indices', () => {
      const path1 = 'electrical.switches.nav';
      const path2 = 'electrical.switches.anchor';
      const path3 = 'electrical.switches.nav'; // Same as path1
      
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
    it('should generate correct switch names from camelCase', () => {
      expect(client._getSwitchName('electrical.switches.nav.state')).toBe('Nav');
      expect(client._getSwitchName('electrical.switches.anchor.state')).toBe('Anchor');
      expect(client._getSwitchName('electrical.switches.cabinLights.state')).toBe('Cabin Lights');
      expect(client._getSwitchName('electrical.switches.navigationLights.state')).toBe('Navigation Lights');
      expect(client._getSwitchName('electrical.switches.deckFloodLights.state')).toBe('Deck Flood Lights');
      expect(client._getSwitchName('electrical.switches.0.state')).toBe('Switch');
      expect(client._getSwitchName('electrical.switches.1.state')).toBe('Switch 2');
    });

    it('should handle unknown switch types gracefully', () => {
      expect(client._getSwitchName('electrical.switches.unknown.state')).toBe('Unknown');
      expect(client._getSwitchName('invalid.path')).toBe('Switch');
    });
  });

  describe('Signal K Updates', () => {
    it('should handle switch state updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch State', 'Nav: ON');
    });

    it('should handle switch state false updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.switches.nav.state', false);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch State', 'Nav: OFF');
    });

    it('should handle switch dimming level updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.switches.cabinLights.dimmingLevel', 0.75);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch Dimming', 'Cabin Lights: 75%');
      
      await client.handleSignalKUpdate('electrical.switches.deckLights.dimmingLevel', 0.75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch Dimming', 'Deck Lights: 75%');
    });

    it('should handle switch position updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.switches.nav.position', 2);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch Position', 'Nav: 2');
    });

    it('should handle dimming level values as percentages (0-1 and 0-100)', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('electrical.switches.cabinLights.dimmingLevel', 0.50);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch Dimming', 'Cabin Lights: 50%');
      
      // Test percentage value (0-100)
      await client.handleSignalKUpdate('electrical.switches.deckLights.dimmingLevel', 75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Switch Dimming', 'Deck Lights: 75%');
    });

    it('should ignore invalid values', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.switches.nav.state', null);
      await client.handleSignalKUpdate('electrical.switches.nav.state', undefined);
      await client.handleSignalKUpdate('electrical.switches.nav.dimmingLevel', 'invalid');
      
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should ignore non-switch paths', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      await client.handleSignalKUpdate('environment.inside.temperature', 25);
      
      expect(emitSpy).not.toHaveBeenCalled();
      expect(client.deviceInstances.size).toBe(0);
    });

    it('should handle multiple switch instances', async () => {
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
      await client.handleSignalKUpdate('electrical.switches.anchor.state', false);
      await client.handleSignalKUpdate('electrical.switches.cabinLights.dimmingLevel', 0.75);
      
      expect(client.deviceInstances.size).toBe(3);
      expect(client.deviceServices.size).toBe(3);
      
      // Check that each instance has correct properties
      expect(client.deviceInstances.has('electrical.switches.nav')).toBe(true);
      expect(client.deviceInstances.has('electrical.switches.anchor')).toBe(true);
      expect(client.deviceInstances.has('electrical.switches.cabinLights')).toBe(true);
    });
  });

  describe('Device Instance Management', () => {
    it('should create device instances on first update', async () => {
      expect(client.deviceInstances.size).toBe(0);
      
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
      
      expect(client.deviceInstances.size).toBe(1);
      const instance = client.deviceInstances.get('electrical.switches.nav');
      expect(instance).toBeDefined();
      expect(instance.name).toBe('Nav');
      expect(instance.basePath).toBe('electrical.switches.nav');
      expect(typeof instance.index).toBe('number');
    });

    it('should reuse existing device instances', async () => {
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
      const firstInstance = client.deviceInstances.get('electrical.switches.nav');
      
      await client.handleSignalKUpdate('electrical.switches.nav.position', 2);
      const secondInstance = client.deviceInstances.get('electrical.switches.nav');
      
      expect(firstInstance).toBe(secondInstance);
      expect(client.deviceInstances.size).toBe(1);
    });

    it('should prevent race conditions in device creation', async () => {
      // Simulate concurrent updates to the same device
      const promises = [
        client.handleSignalKUpdate('electrical.switches.nav.state', true),
        client.handleSignalKUpdate('electrical.switches.nav.position', 2),
        client.handleSignalKUpdate('electrical.switches.nav.name', 'Navigation')
      ];
      
      await Promise.all(promises);
      
      expect(client.deviceInstances.size).toBe(1);
      expect(client.deviceServices.size).toBe(1);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect cleanly', async () => {
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
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
      await expect(client.handleSignalKUpdate('electrical.switches.nav.state', true))
        .resolves.not.toThrow();
      
      // Even with malformed device services, it should handle gracefully
      client.deviceServices.set('electrical.switches.nav', null);
      await expect(client.handleSignalKUpdate('electrical.switches.nav.state', false))
        .resolves.not.toThrow();
    });

    it('should handle malformed paths gracefully', async () => {
      await expect(client.handleSignalKUpdate('', true)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical', true)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical.switches', true)).resolves.not.toThrow();
    });
  });
});
