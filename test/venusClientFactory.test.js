import { describe, it, beforeEach, expect, vi } from 'vitest';

// Mock the client classes before any imports
const mockBatteryClient = vi.fn().mockImplementation(() => ({ type: 'battery' }));
const mockTankClient = vi.fn().mockImplementation(() => ({ type: 'tank' }));
const mockEnvClient = vi.fn().mockImplementation(() => ({ type: 'env' }));
const mockSwitchClient = vi.fn().mockImplementation(() => ({ type: 'switch' }));

// Mock the modules before importing the factory
vi.mock('../venusClient-battery.js', () => ({
  VenusClient: mockBatteryClient
}));

vi.mock('../venusClient-tank.js', () => ({
  VenusClient: mockTankClient
}));

vi.mock('../venusClient-env.js', () => ({
  VenusClient: mockEnvClient
}));

vi.mock('../venusClient-switch.js', () => ({
  VenusClient: mockSwitchClient
}));

describe('VenusClientFactory', () => {
  let VenusClientFactory;
  
  beforeEach(async () => {
    // Clear mocks and dynamically import the factory
    vi.clearAllMocks();
    
    // Re-import the factory to ensure it picks up the mocks
    const factoryModule = await import('../venusClientFactory.js');
    VenusClientFactory = factoryModule.VenusClientFactory;
  });

  const mockSettings = {
    venusHost: 'test.local',
    productName: 'Test Device'
  };

  it('should create battery client for batteries device type', () => {
    const result = VenusClientFactory(mockSettings, 'batteries');
    
    expect(mockBatteryClient).toHaveBeenCalledWith(mockSettings, 'batteries');
    expect(mockTankClient).not.toHaveBeenCalled();
    expect(mockEnvClient).not.toHaveBeenCalled();
    expect(mockSwitchClient).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should create tank client for tanks device type', () => {
    const result = VenusClientFactory(mockSettings, 'tanks');
    
    expect(mockTankClient).toHaveBeenCalledWith(mockSettings, 'tanks');
    expect(mockBatteryClient).not.toHaveBeenCalled();
    expect(mockEnvClient).not.toHaveBeenCalled();
    expect(mockSwitchClient).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should create environment client for environment device type', () => {
    const result = VenusClientFactory(mockSettings, 'environment');
    
    expect(mockEnvClient).toHaveBeenCalledWith(mockSettings, 'environment');
    expect(mockBatteryClient).not.toHaveBeenCalled();
    expect(mockTankClient).not.toHaveBeenCalled();
    expect(mockSwitchClient).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should create switch client for switches device type', () => {
    const result = VenusClientFactory(mockSettings, 'switches');
    
    expect(mockSwitchClient).toHaveBeenCalledWith(mockSettings, 'switches');
    expect(mockBatteryClient).not.toHaveBeenCalled();
    expect(mockTankClient).not.toHaveBeenCalled();
    expect(mockEnvClient).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('should throw error for unsupported device type', () => {
    expect(() => {
      VenusClientFactory(mockSettings, 'unsupported');
    }).toThrow('Unsupported device type: unsupported');
  });

  it('should pass settings correctly to all client types', () => {
    const deviceTypes = ['batteries', 'tanks', 'environment', 'switches'];
    const mocks = [mockBatteryClient, mockTankClient, mockEnvClient, mockSwitchClient];
    
    deviceTypes.forEach((deviceType, index) => {
      const result = VenusClientFactory(mockSettings, deviceType);
      expect(mocks[index]).toHaveBeenCalledWith(mockSettings, deviceType);
      expect(result).toBeDefined();
    });
  });
});
