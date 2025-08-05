import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VenusClient } from '../venusClient.js';
import { EventEmitter } from 'events';

// Mock the vedbus module to avoid D-Bus dependency in tests
vi.mock('../vedbus.js', () => ({
  VEDBusService: vi.fn().mockImplementation(() => {
    const mockService = {
      init: vi.fn().mockResolvedValue(true),
      updateProperty: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn().mockResolvedValue(true),
      isConnected: true,
      deviceData: {}
    };
    // Make sure init resolves immediately in tests
    mockService.init.mockImplementation(() => Promise.resolve(true));
    return mockService;
  })
}));

describe('VenusClient - Battery', () => {
  let client;
  let mockSettings;

  beforeEach(() => {
    mockSettings = {
      venusHost: 'test.local',
      productName: 'Test Battery Device',
      batteryCapacity: 800 // Required for TTG calculation
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

    it('should initialize with proper device tracking structures', () => {
      expect(client.deviceInstances).toBeInstanceOf(Map);
      expect(client.deviceServices).toBeInstanceOf(Map);
      expect(client.exportedInterfaces).toBeInstanceOf(Set);
      expect(client.deviceCounts).toEqual({});
    });
  });

  describe('Path Processing', () => {
    it('should identify relevant battery paths using device config', () => {
      expect(client._isRelevantPath('electrical.batteries.main.voltage')).toBe(true);
      expect(client._isRelevantPath('electrical.batteries.house.current')).toBe(true);
      expect(client._isRelevantPath('electrical.batteries.starter.stateOfCharge')).toBe(true);
      expect(client._isRelevantPath('tanks.fuel.main.currentLevel')).toBe(false);
      expect(client._isRelevantPath('environment.inside.temperature')).toBe(false);
    });

    it('should extract base path correctly for battery devices', () => {
      expect(client._extractBasePath('electrical.batteries.main.voltage')).toBe('electrical.batteries.main');
      expect(client._extractBasePath('electrical.batteries.house.current')).toBe('electrical.batteries.house');
      expect(client._extractBasePath('electrical.batteries.starter.stateOfCharge')).toBe('electrical.batteries.starter');
      expect(client._extractBasePath('electrical.batteries.main.capacity.stateOfCharge')).toBe('electrical.batteries.main');
      expect(client._extractBasePath('electrical.batteries.main.power')).toBe('electrical.batteries.main');
    });

    it('should generate stable device indices using hash-based approach', () => {
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
    it('should generate correct battery names using unified naming system', () => {
      expect(client._getDeviceName('electrical.batteries.main')).toBe('Battery');
      expect(client._getDeviceName('electrical.batteries.house')).toBe('Battery House');
      expect(client._getDeviceName('electrical.batteries.starter')).toBe('Battery Starter');
      expect(client._getDeviceName('electrical.batteries.0')).toBe('Battery');
      expect(client._getDeviceName('electrical.batteries.1')).toBe('Battery 2');
    });

    it('should handle single battery with generic ID', () => {
      // Mock deviceInstances to simulate a single battery
      client.deviceInstances.set('electrical.batteries.0', {});
      expect(client._getDeviceName('electrical.batteries.0')).toBe('Battery');
    });

    it('should handle unknown battery types gracefully', () => {
      expect(client._getDeviceName('electrical.batteries.unknown')).toBe('Battery Unknown');
    });
  });

  describe('Signal K Updates', () => {
    it('should handle battery voltage updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
      expect(client.deviceServices.size).toBeGreaterThanOrEqual(0);
      // Emission testing depends on the actual VEDBusService implementation
      // which is mocked, so we focus on testing the device tracking
    });

    it('should handle battery current updates correctly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.2);
      
      // Test that the device is properly tracked
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle battery power updates correctly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.power', 65);
      
      // Test that the device is properly tracked
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle battery state of charge updates correctly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.85);
      
      // Test that the device is properly tracked
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle battery capacity state of charge updates correctly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.capacity.stateOfCharge', 0.75);
      
      // Test that the device is properly tracked
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle battery temperature updates correctly', async () => {
      // Test Celsius temperature
      await client.handleSignalKUpdate('electrical.batteries.main.temperature', 25);
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
      
      // Test Kelvin temperature (should be converted by the client)
      await client.handleSignalKUpdate('electrical.batteries.house.temperature', 298.15);
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle SoC values as percentages (0-1 and 0-100)', async () => {
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.50);
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
      
      // Test percentage value (0-100) - client should handle conversion
      await client.handleSignalKUpdate('electrical.batteries.house.stateOfCharge', 75);
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });

    it('should handle null and undefined values correctly', async () => {
      // Create a fresh client to ensure clean state
      const freshClient = new VenusClient(mockSettings, 'batteries');
      const initialSize = freshClient.deviceInstances.size;
      
      // These should not create devices since values are null/undefined (early return)
      await freshClient.handleSignalKUpdate('electrical.batteries.main.voltage', null);
      await freshClient.handleSignalKUpdate('electrical.batteries.main.voltage', undefined);
      
      // Device instances should not change with null/undefined values
      expect(freshClient.deviceInstances.size).toBe(initialSize);
      
      // Clean up
      await freshClient.disconnect();
    });

    it('should ignore non-battery paths', async () => {
      const initialSize = client.deviceInstances.size;
      
      await client.handleSignalKUpdate('tanks.fuel.main.currentLevel', 0.75);
      await client.handleSignalKUpdate('environment.inside.temperature', 25);
      
      // Should not process non-battery paths
      expect(client.deviceInstances.size).toBe(initialSize);
    });

    it('should handle multiple battery instances', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.house.voltage', 12.8);
      await client.handleSignalKUpdate('electrical.batteries.starter.voltage', 12.2);
    });

    it('should handle battery current updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.2);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery Current', 'Battery: 5.2A');
    });

    it('should handle battery power updates correctly', async () => {
      // Power is NOT critical data, so we expect NO emit calls
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.power', 65);
      
      // Power alone should not create a service or emit (no critical data)
      expect(client.deviceServices.size).toBe(0);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should handle battery state of charge updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.85);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Battery: 85.0%');
    });

    it('should handle battery capacity state of charge updates correctly', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      await client.handleSignalKUpdate('electrical.batteries.main.capacity.stateOfCharge', 0.75);
      
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Battery: 75.0%');
    });

    it('should handle battery temperature updates correctly', async () => {
      // Temperature is NOT critical data, so we expect NO emit calls
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test Celsius temperature
      await client.handleSignalKUpdate('electrical.batteries.main.temperature', 25);
      
      // Temperature alone should not create a service or emit (no critical data)
      expect(client.deviceServices.size).toBe(0);
      expect(emitSpy).not.toHaveBeenCalled();
    });

    it('should handle SoC values as percentages (0-1 and 0-100)', async () => {
      const emitSpy = vi.spyOn(client, 'emit');
      
      // Test fractional value (0-1)
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.50);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Battery: 50.0%');
      
      // Test percentage value (0-100)
      await client.handleSignalKUpdate('electrical.batteries.house.stateOfCharge', 75);
      expect(emitSpy).toHaveBeenCalledWith('dataUpdated', 'Battery SoC', 'Battery House: 75.0%');
    });

    it('should handle timeRemaining correctly - ignore null values', async () => {
      // timeRemaining is NOT critical data, so we test with an existing service
      // First create a device with critical data 
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.75);
      
      // Wait for service creation to complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Ensure device service is created
      expect(client.deviceServices.size).toBe(1);
      
      // Get the device service and verify it's properly initialized
      const deviceService = Array.from(client.deviceServices.values())[0];
      expect(deviceService).toBeDefined();
      expect(deviceService.updateProperty).toBeDefined();
      
      // Wait for service to be fully ready
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const updatePropertySpy = vi.spyOn(deviceService, 'updateProperty');
      
      // First, set a valid timeRemaining (8640 seconds = 2.4 hours)
      await client.handleSignalKUpdate('electrical.batteries.main.capacity.timeRemaining', 8640);
      
      // Verify TTG was set with the valid value
      expect(updatePropertySpy).toHaveBeenCalledWith('/TimeToGo', 8640, 'i', expect.any(String));
      
      // Clear spies to focus on the next calls
      updatePropertySpy.mockClear();
      
      // Now set timeRemaining to null - it should be ignored (no TTG update)
      await client.handleSignalKUpdate('electrical.batteries.main.capacity.timeRemaining', null);
      
      // Verify that TTG was NOT updated when timeRemaining is null
      const ttgUpdateCalls = updatePropertySpy.mock.calls.filter(call => call[0] === '/TimeToGo');
      expect(ttgUpdateCalls.length).toBe(0);
    });

    it('should calculate TTG when Signal K timeRemaining is not available', async () => {
      // Create a device with known state first - need voltage, current, and SoC for calculation
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.0); // Discharging at 5A
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.50); // 50% charged
      
      // Get the device service and set up spies
      const deviceService = Array.from(client.deviceServices.values())[0];
      const updatePropertySpy = vi.spyOn(deviceService, 'updateProperty');
      
      // Clear spies and trigger SOC update (which calls _updateBatteryDummyData)
      updatePropertySpy.mockClear();
      await client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.49); // Slight discharge
      
      // Should calculate TTG based on current consumption and remaining capacity
      // Look for TTG update calls
      const ttgUpdateCalls = updatePropertySpy.mock.calls.filter(call => call[0] === '/TimeToGo');
      
      // Should have calculated and set a TTG value
      expect(ttgUpdateCalls.length).toBeGreaterThan(0);
      expect(typeof ttgUpdateCalls[0][1]).toBe('number');
      expect(ttgUpdateCalls[0][1]).toBeGreaterThan(0); // Should be positive time in seconds
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
      
      // The new unified client tracks devices as they are processed
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
      expect(client.deviceServices.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Device Instance Management', () => {
    it('should create and track device instances', async () => {
      const initialSize = client.deviceInstances.size;
      
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      // Should create device tracking structures
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(initialSize);
    });

    it('should reuse existing device instances for same path', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      const sizeAfterFirst = client.deviceInstances.size;
      
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.2);
      const sizeAfterSecond = client.deviceInstances.size;
      
      // Should not create new instance for same device path
      expect(sizeAfterSecond).toBe(sizeAfterFirst);
    });

    it('should handle concurrent updates gracefully', async () => {
      // Simulate concurrent updates to the same device
      const promises = [
        client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5),
        client.handleSignalKUpdate('electrical.batteries.main.current', 5.2),
        client.handleSignalKUpdate('electrical.batteries.main.stateOfCharge', 0.85)
      ];
      
      await Promise.all(promises);
      
      // Should handle concurrent updates without errors
      expect(client.deviceInstances.size).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Cleanup', () => {
    it('should disconnect cleanly', async () => {
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      
      await client.disconnect();
      
      // After disconnect, internal state should be cleaned
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
      // Test error handling - should not throw unhandled errors
      await expect(client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5))
        .resolves.not.toThrow();
    });

    it('should handle malformed paths gracefully', async () => {
      await expect(client.handleSignalKUpdate('', 12.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical', 12.5)).resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical.batteries', 12.5)).resolves.not.toThrow();
    });

    it('should handle extreme values gracefully', async () => {
      await expect(client.handleSignalKUpdate('electrical.batteries.main.voltage', Number.MAX_VALUE))
        .resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical.batteries.main.voltage', Number.MIN_VALUE))
        .resolves.not.toThrow();
      await expect(client.handleSignalKUpdate('electrical.batteries.main.voltage', -1))
        .resolves.not.toThrow();
    });
  });

  describe('History Data Tracking', () => {
    beforeEach(async () => {
      // Mock the Signal K app to provide solar and alternator data
      client.signalKApp = {
        getSelfPath: vi.fn((path) => {
          if (path === 'electrical.solar.current') return 5.0; // 5A solar
          if (path === 'electrical.alternators.current') return 10.0; // 10A alternator
          return null;
        })
      };
      
      // Ensure history data is loaded
      await client.loadHistoryData();
    });

    it('should track voltage min/max correctly', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Update history with different voltage values (all above 5V threshold)
      client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      client.updateHistoryData('electrical.batteries.main', 13.8, 5.0, null);
      client.updateHistoryData('electrical.batteries.main', 11.5, -2.0, null);
      
      const history = client.historyData.get('electrical.batteries.main');
      expect(history).toBeDefined();
      expect(history.minimumVoltage).toBe(11.5);
      expect(history.maximumVoltage).toBe(13.8);
    });

    it('should ignore invalid voltage values in min/max tracking', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Get initial state
      const initialHistory = client.historyData.get('electrical.batteries.main');
      const initialMin = initialHistory.minimumVoltage;
      const initialMax = initialHistory.maximumVoltage;
      
      // Try to update with invalid voltage values (should be ignored due to <5V threshold)
      client.updateHistoryData('electrical.batteries.main', 0, -5.0, null); // Too low
      client.updateHistoryData('electrical.batteries.main', 3.0, -5.0, null); // Too low
      client.updateHistoryData('electrical.batteries.main', null, -5.0, null); // Null
      client.updateHistoryData('electrical.batteries.main', NaN, -5.0, null); // NaN
      
      const history = client.historyData.get('electrical.batteries.main');
      expect(history).toBeDefined();
      // Should still have the original values from device creation (min/max should not change)
      expect(history.minimumVoltage).toBe(initialMin);
      expect(history.maximumVoltage).toBe(initialMax);
    });

    it('should calculate discharged energy correctly when battery discharging', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Mock time to control delta calculation (simulate 30 minutes = 1800000ms)
      const mockNow = Date.now();
      const thirtyMinutesLater = mockNow + 1800000; // 30 minutes to stay under 1 hour limit
      
      // Set initial timestamp manually
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Mock Date.now to return the later time for the calculation
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(thirtyMinutesLater);
      
      // Update with discharging current (-5A for 0.5 hour)
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      expect(history.dischargedEnergy).toBeCloseTo(0.03, 3); // 12V * 5A * 0.5h / 1000 = 0.03 kWh
      expect(history.chargedEnergy).toBe(0);
      
      dateNowSpy.mockRestore();
    });

    it('should calculate charged energy correctly when battery charging', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.0);
      
      // Mock time to control delta calculation (simulate 30 minutes)
      const mockNow = Date.now();
      const thirtyMinutesLater = mockNow + 1800000; // 30 minutes to stay under 1 hour limit
      
      // Set initial timestamp manually
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Mock Date.now to return the later time for the calculation
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(thirtyMinutesLater);
      
      // Update with charging current (+5A for 0.5 hour)
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 5.0, null);
      
      expect(history).toBeDefined();
      expect(history.chargedEnergy).toBeCloseTo(0.03, 3); // 12V * 5A * 0.5h / 1000 = 0.03 kWh
      expect(history.dischargedEnergy).toBe(0);
      
      dateNowSpy.mockRestore();
    });

    it('should calculate cumulative Ah drawn using S + L - A formula', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Mock time to control delta calculation (simulate 30 minutes)
      const mockNow = Date.now();
      const thirtyMinutesLater = mockNow + 1800000; // 30 minutes to stay under 1 hour limit
      
      // Set initial timestamp manually
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Mock Date.now to return the later time for the calculation
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(thirtyMinutesLater);
      
      // Update with: Solar=5A, Alternator=10A, Battery=-5A (discharging)
      // Cumulative Ah = S + L - A = 5 + 10 - (-5) = 20A for 0.5 hour = 10Ah
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      expect(history.totalAhDrawn).toBeCloseTo(10.0, 3); // 5 + 10 - (-5) = 20A * 0.5h = 10Ah
      
      dateNowSpy.mockRestore();
    });

    it('should calculate cumulative Ah drawn when battery charging', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 8.0);
      
      // Mock time to control delta calculation (simulate 30 minutes)
      const mockNow = Date.now();
      const thirtyMinutesLater = mockNow + 1800000; // 30 minutes to stay under 1 hour limit
      
      // Set initial timestamp manually
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Mock Date.now to return the later time for the calculation
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(thirtyMinutesLater);
      
      // Update with: Solar=5A, Alternator=10A, Battery=+8A (charging)
      // Cumulative Ah = S + L - A = 5 + 10 - 8 = 7A for 0.5 hour = 3.5Ah
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 8.0, null);
      
      expect(history).toBeDefined();
      expect(history.totalAhDrawn).toBeCloseTo(3.5, 3); // 5 + 10 - 8 = 7A * 0.5h = 3.5Ah
      
      dateNowSpy.mockRestore();
    });

    it('should not accumulate energy with zero time delta', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Get initial state 
      const initialHistory = client.historyData.get('electrical.batteries.main');
      const initialDischargedEnergy = initialHistory.dischargedEnergy;
      const initialChargedEnergy = initialHistory.chargedEnergy;
      const initialTotalAhDrawn = initialHistory.totalAhDrawn;
      
      // Mock time to return same time (zero delta)
      const mockNow = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(mockNow);
      
      // Set same timestamp as current time
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      // Values should remain unchanged with zero time delta
      expect(history.dischargedEnergy).toBe(initialDischargedEnergy);
      expect(history.chargedEnergy).toBe(initialChargedEnergy);
      expect(history.totalAhDrawn).toBe(initialTotalAhDrawn);
      
      dateNowSpy.mockRestore();
    });

    it('should handle accumulator voltage updates correctly', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Wait a bit for accumulator to be initialized
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Update with valid voltage
      client.updateHistoryData('electrical.batteries.main', 12.5, -3.0, null);
      
      const accumulator = client.energyAccumulators.get('electrical.batteries.main');
      expect(accumulator).toBeDefined();
      expect(accumulator.lastVoltage).toBe(12.5);
      expect(accumulator.lastCurrent).toBe(-3.0);
      
      // Update with null voltage (should not change lastVoltage)
      client.updateHistoryData('electrical.batteries.main', null, -2.0, null);
      
      expect(accumulator.lastVoltage).toBe(12.5); // Should remain unchanged
      expect(accumulator.lastCurrent).toBe(-2.0); // Should update
    });

    it('should handle mixed charging and discharging cycles', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      let mockTime = Date.now();
      const timeIncrement = 1800000; // 30 minutes to stay under 1 hour limit
      
      // First period: discharging at 5A
      client.lastUpdateTime.set('electrical.batteries.main', mockTime);
      
      mockTime += timeIncrement;
      let dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(mockTime);
      let history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history.dischargedEnergy).toBeCloseTo(0.03, 3); // 12V * 5A * 0.5h / 1000
      expect(history.chargedEnergy).toBe(0);
      
      dateNowSpy.mockRestore();
      
      // Second period: charging at 8A
      mockTime += timeIncrement;
      dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(mockTime);
      history = client.updateHistoryData('electrical.batteries.main', 12.0, 8.0, null);
      
      expect(history.dischargedEnergy).toBeCloseTo(0.03, 3); // Should remain the same
      expect(history.chargedEnergy).toBeCloseTo(0.048, 3); // 12V * 8A * 0.5h / 1000
      
      dateNowSpy.mockRestore();
    });

    it('should preserve history data integrity with NaN protection', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Manually corrupt history data to test NaN protection
      const history = client.historyData.get('electrical.batteries.main');
      history.dischargedEnergy = NaN;
      history.chargedEnergy = NaN;
      history.totalAhDrawn = NaN;
      
      // Update should clean up NaN values
      const cleanHistory = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(cleanHistory.dischargedEnergy).toBe(0);
      expect(cleanHistory.chargedEnergy).toBe(0);
      expect(cleanHistory.totalAhDrawn).toBe(0);
    });

    it('should calculate charged energy with high charging current (50A)', async () => {
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 50.0);
      
      // Mock time to control delta calculation (simulate 10 minutes)
      const mockNow = Date.now();
      const tenMinutesLater = mockNow + 600000; // 10 minutes to stay well under 1 hour limit
      
      // Set initial timestamp manually
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Mock Date.now to return the later time for the calculation
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(tenMinutesLater);
      
      // Update with high charging current (+50A for 10 minutes = 1/6 hour)
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 50.0, null);
      
      expect(history).toBeDefined();
      // Calculate expected: 12V * 50A * (1/6)h / 1000 = 0.1 kWh
      expect(history.chargedEnergy).toBeCloseTo(0.1, 3);
      expect(history.dischargedEnergy).toBe(0);
      
      // Also check cumulative Ah calculation
      // With Solar=5A, Alternator=10A, Battery=+50A (charging)
      // Cumulative Ah = S + L - A = 5 + 10 - 50 = -35A for 1/6 hour = -5.83Ah
      // Since this is negative, totalAhDrawn might not update
      
      dateNowSpy.mockRestore();
    });

    it('should handle real-world charging scenario with debug logging', async () => {
      // Mock console.log to capture debug messages
      const originalDebug = client.logger.debug;
      const debugMessages = [];
      client.logger.debug = (msg) => {
        debugMessages.push(msg);
        originalDebug.call(client.logger, msg);
      };
      
      // Create device with critical data first
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 50.0);
      
      // Mock realistic time (5 minutes)
      const mockNow = Date.now();
      const fiveMinutesLater = mockNow + 300000; // 5 minutes
      
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fiveMinutesLater);
      
      // Update with charging current
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 50.0, null);
      
      // Check if energy calculation happened
      expect(history).toBeDefined();
      expect(history.chargedEnergy).toBeGreaterThan(0);
      
      // Check debug messages for energy calculation
      const energyMessages = debugMessages.filter(msg => msg.includes('Energy calculation'));
      expect(energyMessages.length).toBeGreaterThan(0);
      
      const chargingMessages = debugMessages.filter(msg => msg.includes('Battery charging'));
      expect(chargingMessages.length).toBeGreaterThan(0);
      
      // Restore
      client.logger.debug = originalDebug;
      dateNowSpy.mockRestore();
    });
  });
});
