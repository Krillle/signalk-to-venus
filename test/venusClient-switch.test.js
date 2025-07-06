import { describe, it, beforeEach, expect, vi } from 'vitest';
import { VenusClient } from '../venusClient-switch.js';

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
      setTimeout(() => callback(null, 1), 0);
    });
    mockBus.exportInterface.mockImplementation(() => {});
    mockBus.end.mockImplementation(() => {});
    mockBus.invoke.mockImplementation((options, callback) => {
      // Mock Settings API response
      setTimeout(() => callback(null, []), 0);
    });
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
      
      const instance = await client._getOrCreateSwitchInstance(path);
      
      expect(instance.basePath).toBe('electrical.switches.nav');
      expect(instance.name).toBe('Nav');
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(true);
    });

    it('should extract correct base path from switch property paths', async () => {
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
    it('should handle switch state updates correctly', async () => {
      const path = 'electrical.switches.nav.state';
      const value = true;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a switch instance was created
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(true);
      expect(client.switchServices.has('electrical.switches.nav')).toBe(true);
      
      // Check that the service was created
      const service = client.switchServices.get('electrical.switches.nav');
      expect(service).toBeDefined();
      expect(service.switchData['/State']).toBe(1); // true should be converted to 1
    });

    it('should handle dimming level updates correctly', async () => {
      const path = 'electrical.switches.cabinLights.dimmingLevel';
      const value = 0.75; // 75% as decimal
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a switch instance was created
      expect(client.switchInstances.has('electrical.switches.cabinLights')).toBe(true);
      expect(client.switchServices.has('electrical.switches.cabinLights')).toBe(true);
      
      // Check that the service was created
      const service = client.switchServices.get('electrical.switches.cabinLights');
      expect(service).toBeDefined();
      expect(service.switchData['/DimmingLevel']).toBe(75); // Should be converted to percentage
    });

    it('should handle false state correctly', async () => {
      const path = 'electrical.switches.nav.state';
      const value = false;
      
      await client.handleSignalKUpdate(path, value);
      
      // Check that a switch instance was created
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(true);
      expect(client.switchServices.has('electrical.switches.nav')).toBe(true);
      
      // Check that the service was created
      const service = client.switchServices.get('electrical.switches.nav');
      expect(service).toBeDefined();
      expect(service.switchData['/State']).toBe(0); // false should be converted to 0
    });

    it('should skip invalid values', async () => {
      const path = 'electrical.switches.nav.state';
      
      await client.handleSignalKUpdate(path, null);
      await client.handleSignalKUpdate(path, undefined);
      await client.handleSignalKUpdate(path, 'invalid');
      
      // Check that no instances were created for invalid values
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(false);
      expect(client.switchServices.has('electrical.switches.nav')).toBe(false);
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
      
      // Check that no instances were created for unknown properties
      expect(client.switchInstances.has('electrical.switches.nav')).toBe(false);
      expect(client.switchServices.has('electrical.switches.nav')).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect all switch services on disconnect', async () => {
      // Create some switch instances
      await client.handleSignalKUpdate('electrical.switches.nav.state', true);
      await client.handleSignalKUpdate('electrical.switches.anchor.state', false);
      
      // Verify services were created
      expect(client.switchServices.size).toBe(2);
      expect(client.switchInstances.size).toBe(2);
      
      // Mock the disconnect method on services
      const navService = client.switchServices.get('electrical.switches.nav');
      const anchorService = client.switchServices.get('electrical.switches.anchor');
      
      if (navService) vi.spyOn(navService, 'disconnect').mockImplementation(() => {});
      if (anchorService) vi.spyOn(anchorService, 'disconnect').mockImplementation(() => {});
      
      await client.disconnect();
      
      // Verify all services were disconnected
      if (navService) expect(navService.disconnect).toHaveBeenCalled();
      if (anchorService) expect(anchorService.disconnect).toHaveBeenCalled();
      
      // Verify data structures were cleared
      expect(client.switchInstances.size).toBe(0);
      expect(client.switchServices.size).toBe(0);
      expect(client.exportedInterfaces.size).toBe(0);
    });
  });
});
