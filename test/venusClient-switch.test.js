import { describe, it, beforeEach, expect, vi } from 'vitest';
import { VenusClient } from '../venusClient-switch.js';

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

describe('VenusClient - Switch', () => {
  let client;
  let settings;

  beforeEach(() => {
    settings = {
      venusHost: 'test.local',
      productName: 'Test Switch',
      interval: 1000
    };
    
    client = new VenusClient(settings, 'switches');
    
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

  describe('Switch Instance Management', () => {
    it('should generate stable indices for switch paths', () => {
      const path1 = 'electrical.switches.nav';
      const path2 = 'electrical.switches.nav';
      const path3 = 'electrical.switches.anchor';
      
      const index1 = client._generateStableIndex(path1);
      const index2 = client._generateStableIndex(path2);
      const index3 = client._generateStableIndex(path3);
      
      expect(index1).toBe(index2); // Same path should give same index
      expect(index1).not.toBe(index3); // Different path should give different index
      expect(index1).toBeGreaterThanOrEqual(0);
      expect(index1).toBeLessThan(1000);
    });

    it('should create new switch instance for new path', async () => {
      const path = 'electrical.switches.nav.state';
      
      vi.spyOn(client, '_registerSwitchInSettings').mockResolvedValue(456);
      
      const instance = await client._getOrCreateSwitchInstance(path);
      
      expect(instance.basePath).toBe('electrical.switches.nav');
      expect(instance.name).toBe('Nav');
      expect(instance.vrmInstanceId).toBe(456);
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(true);
    });

    it('should extract correct base path from switch property paths', async () => {
      vi.spyOn(client, '_registerSwitchInSettings').mockResolvedValue(456);
      
      const paths = [
        'electrical.switches.nav.state',
        'electrical.switches.nav.dimmingLevel'
      ];
      
      const instances = await Promise.all(
        paths.map(path => client._getOrCreateSwitchInstance(path))
      );
      
      expect(instances[0]).toStrictEqual(instances[1]);
      expect(instances[0].basePath).toBe('electrical.switches.nav');
    });
  });

  describe('Switch Name Generation', () => {
    it('should generate correct switch names', () => {
      expect(client._getSwitchName('electrical.switches.nav.state')).toBe('Nav');
      expect(client._getSwitchName('electrical.switches.anchor.state')).toBe('Anchor');
      expect(client._getSwitchName('electrical.switches.cabinLights.state')).toBe('Cabin Lights');
      expect(client._getSwitchName('electrical.switches.bilgePump.state')).toBe('Bilge Pump');
    });

    it('should handle camelCase conversion', () => {
      expect(client._getSwitchName('electrical.switches.navigationLights.state')).toBe('Navigation Lights');
      expect(client._getSwitchName('electrical.switches.mastHead.state')).toBe('Mast Head');
    });
  });

  describe('Signal K Update Handling', () => {
    beforeEach(async () => {
      // Mock the init method to avoid actual network connections
      vi.spyOn(client, 'init').mockResolvedValue();
      client.bus = mockBus;
      client.settingsBus = mockBus;
      vi.spyOn(client, '_registerSwitchInSettings').mockResolvedValue(456);
      vi.spyOn(client, '_exportProperty').mockImplementation(() => {});
    });

    it('should handle switch state updates correctly', async () => {
      const path = 'electrical.switches.nav.state';
      const value = true;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Switch/456/State',
        expect.objectContaining({
          value: 1, // true should be converted to 1
          type: 'i',
          text: expect.stringContaining('state')
        })
      );
    });

    it('should handle dimming level updates correctly', async () => {
      const path = 'electrical.switches.cabinLights.dimmingLevel';
      const value = 0.75; // 75% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Switch/456/DimmingLevel',
        expect.objectContaining({
          value: 75, // Should be converted to percentage
          type: 'i',
          text: expect.stringContaining('dimming')
        })
      );
    });

    it('should handle false state correctly', async () => {
      const path = 'electrical.switches.nav.state';
      const value = false;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).toHaveBeenCalledWith(
        '/Switch/456/State',
        expect.objectContaining({
          value: 0, // false should be converted to 0
          type: 'i'
        })
      );
    });

    it('should skip invalid values', async () => {
      const path = 'electrical.switches.nav.state';
      
      await client.handleSignalKUpdate(path, null);
      await client.handleSignalKUpdate(path, undefined);
      await client.handleSignalKUpdate(path, 'invalid');
      
      expect(client._exportProperty).not.toHaveBeenCalled();
    });

    it('should emit dataUpdated events', async () => {
      const dataUpdatedSpy = vi.fn();
      client.on('dataUpdated', dataUpdatedSpy);
      
      const path = 'electrical.switches.nav.state';
      const value = true;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(dataUpdatedSpy).toHaveBeenCalledWith(
        'Switch State',
        expect.stringContaining('ON')
      );
    });

    it('should ignore unknown switch paths', async () => {
      const path = 'electrical.switches.nav.unknownProperty';
      const value = 123;
      
      await client.handleSignalKUpdate(path, value);
      
      expect(client._exportProperty).not.toHaveBeenCalled();
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
      const path = '/Switch/1/State';
      const config = { value: 1, type: 'i', text: 'Test state' };
      
      // First export
      client._exportProperty(path, config);
      expect(mockBus.exportInterface).toHaveBeenCalledTimes(1);
      expect(client.exportedInterfaces.has(path)).toBe(true);
      
      // Second export should not call exportInterface again
      client._exportProperty(path, { value: 0, type: 'i', text: 'Test state' });
      expect(mockBus.exportInterface).toHaveBeenCalledTimes(1);
      expect(client.switchData[path]).toBe(0); // Value should be updated
    });
  });

  describe('Cleanup', () => {
    beforeEach(async () => {
      // Mock the init method to avoid actual network connections
      vi.spyOn(client, 'init').mockResolvedValue();
      client.bus = mockBus;
      client.settingsBus = mockBus;
    });

    it('should clear all data structures on disconnect', async () => {
      // Add some data
      client.switchData['/Switch/1/State'] = 1;
      client.switchInstances.set('electrical.switches.nav', { index: 1 });
      client.exportedInterfaces.add('/Switch/1/State');
      
      await client.disconnect();
      
      expect(client.switchData).toEqual({});
      expect(client.switchInstances.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
    });
  });
});
