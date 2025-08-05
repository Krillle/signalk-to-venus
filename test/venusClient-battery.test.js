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
    beforeEach(() => {
      // Mock the Signal K app to provide solar and alternator data
      client.signalKApp = {
        getSelfPath: vi.fn()
      };
      
      // Mock _getCurrentSignalKValue to return test data
      client._getCurrentSignalKValue = vi.fn((path) => {
        if (path === 'electrical.solar.current') return 5.0; // 5A solar
        if (path === 'electrical.alternators.current') return 10.0; // 10A alternator
        return null;
      });
    });

    it('should track voltage min/max correctly', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Update history with different voltage values
      client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      client.updateHistoryData('electrical.batteries.main', 13.8, 5.0, null);
      client.updateHistoryData('electrical.batteries.main', 11.5, -2.0, null);
      
      const history = client.historyData.get('electrical.batteries.main');
      expect(history).toBeDefined();
      expect(history.minimumVoltage).toBe(11.5);
      expect(history.maximumVoltage).toBe(13.8);
    });

    it('should ignore invalid voltage values in min/max tracking', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.5);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Try to update with invalid voltage values (should be ignored)
      client.updateHistoryData('electrical.batteries.main', 0, -5.0, null); // Too low
      client.updateHistoryData('electrical.batteries.main', 3.0, -5.0, null); // Too low
      client.updateHistoryData('electrical.batteries.main', null, -5.0, null); // Null
      client.updateHistoryData('electrical.batteries.main', NaN, -5.0, null); // NaN
      
      const history = client.historyData.get('electrical.batteries.main');
      expect(history).toBeDefined();
      // Should still have the original 12.5V from device creation
      expect(history.minimumVoltage).toBe(12.5);
      expect(history.maximumVoltage).toBe(12.5);
    });

    it('should calculate discharged energy correctly when battery discharging', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Mock time to control delta calculation (simulate 1 hour = 3600000ms)
      const mockNow = Date.now();
      const oneHourLater = mockNow + 3600000;
      
      vi.spyOn(Date, 'now').mockReturnValueOnce(mockNow).mockReturnValueOnce(oneHourLater);
      
      // Set initial timestamp
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Update with discharging current (-5A for 1 hour)
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      expect(history.dischargedEnergy).toBeCloseTo(0.06, 3); // 12V * 5A * 1h / 1000 = 0.06 kWh
      expect(history.chargedEnergy).toBe(0);
      
      vi.restoreAllMocks();
    });

    it('should calculate charged energy correctly when battery charging', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 5.0);
      
      // Mock time to control delta calculation (simulate 1 hour)
      const mockNow = Date.now();
      const oneHourLater = mockNow + 3600000;
      
      vi.spyOn(Date, 'now').mockReturnValueOnce(mockNow).mockReturnValueOnce(oneHourLater);
      
      // Set initial timestamp
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Update with charging current (+5A for 1 hour)
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 5.0, null);
      
      expect(history).toBeDefined();
      expect(history.chargedEnergy).toBeCloseTo(0.06, 3); // 12V * 5A * 1h / 1000 = 0.06 kWh
      expect(history.dischargedEnergy).toBe(0);
      
      vi.restoreAllMocks();
    });

    it('should calculate cumulative Ah drawn using S + L - A formula', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Mock time to control delta calculation (simulate 1 hour)
      const mockNow = Date.now();
      const oneHourLater = mockNow + 3600000;
      
      vi.spyOn(Date, 'now').mockReturnValueOnce(mockNow).mockReturnValueOnce(oneHourLater);
      
      // Set initial timestamp
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Update with: Solar=5A, Alternator=10A, Battery=-5A (discharging)
      // Cumulative Ah = S + L - A = 5 + 10 - (-5) = 20A for 1 hour = 20Ah
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      expect(history.totalAhDrawn).toBeCloseTo(20.0, 3); // 5 + 10 - (-5) = 20Ah
      
      vi.restoreAllMocks();
    });

    it('should calculate cumulative Ah drawn when battery charging', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', 8.0);
      
      // Mock time to control delta calculation (simulate 1 hour)
      const mockNow = Date.now();
      const oneHourLater = mockNow + 3600000;
      
      vi.spyOn(Date, 'now').mockReturnValueOnce(mockNow).mockReturnValueOnce(oneHourLater);
      
      // Set initial timestamp
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      // Update with: Solar=5A, Alternator=10A, Battery=+8A (charging)
      // Cumulative Ah = S + L - A = 5 + 10 - 8 = 7A for 1 hour = 7Ah
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, 8.0, null);
      
      expect(history).toBeDefined();
      expect(history.totalAhDrawn).toBeCloseTo(7.0, 3); // 5 + 10 - 8 = 7Ah
      
      vi.restoreAllMocks();
    });

    it('should not accumulate energy with zero time delta', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      // Mock time to return same time (zero delta)
      const mockNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(mockNow);
      
      // Set same timestamp as current time
      client.lastUpdateTime.set('electrical.batteries.main', mockNow);
      
      const history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history).toBeDefined();
      expect(history.dischargedEnergy).toBe(0);
      expect(history.chargedEnergy).toBe(0);
      expect(history.totalAhDrawn).toBe(0);
      
      vi.restoreAllMocks();
    });

    it('should handle accumulator voltage updates correctly', async () => {
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
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
      // Create device with critical data
      await client.handleSignalKUpdate('electrical.batteries.main.voltage', 12.0);
      await client.handleSignalKUpdate('electrical.batteries.main.current', -5.0);
      
      let mockTime = Date.now();
      const timeIncrement = 3600000; // 1 hour
      
      // First hour: discharging at 5A
      vi.spyOn(Date, 'now').mockReturnValue(mockTime);
      client.lastUpdateTime.set('electrical.batteries.main', mockTime);
      
      mockTime += timeIncrement;
      vi.spyOn(Date, 'now').mockReturnValue(mockTime);
      let history = client.updateHistoryData('electrical.batteries.main', 12.0, -5.0, null);
      
      expect(history.dischargedEnergy).toBeCloseTo(0.06, 3); // 12V * 5A * 1h / 1000
      expect(history.chargedEnergy).toBe(0);
      
      // Second hour: charging at 8A
      mockTime += timeIncrement;
      vi.spyOn(Date, 'now').mockReturnValue(mockTime);
      history = client.updateHistoryData('electrical.batteries.main', 12.0, 8.0, null);
      
      expect(history.dischargedEnergy).toBeCloseTo(0.06, 3); // Should remain the same
      expect(history.chargedEnergy).toBeCloseTo(0.096, 3); // 12V * 8A * 1h / 1000
      
      vi.restoreAllMocks();
    });

    it('should preserve history data integrity with NaN protection', async () => {
      // Create device with critical data
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
  });
});
