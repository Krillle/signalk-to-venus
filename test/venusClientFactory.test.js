import { describe, it, expect } from 'vitest';
import { VenusClientFactory } from '../venusClientFactory.js';

describe('VenusClientFactory', () => {
  const mockSettings = {
    venusHost: 'test.local',
    productName: 'Test Device'
  };

  it('should create battery client for batteries device type', () => {
    const result = VenusClientFactory(mockSettings, 'batteries');
    
    expect(result).toBeDefined();
    expect(result.constructor.name).toBe('VenusClient');
    expect(result.settings).toEqual(mockSettings);
    expect(result.deviceType).toBe('batteries');
  });

  it('should create tank client for tanks device type', () => {
    const result = VenusClientFactory(mockSettings, 'tanks');
    
    expect(result).toBeDefined();
    expect(result.constructor.name).toBe('VenusClient');
    expect(result.settings).toEqual(mockSettings);
    expect(result.deviceType).toBe('tanks');
  });

  it('should create environment client for environment device type', () => {
    const result = VenusClientFactory(mockSettings, 'environment');
    
    expect(result).toBeDefined();
    expect(result.constructor.name).toBe('VenusClient');
    expect(result.settings).toEqual(mockSettings);
    expect(result.deviceType).toBe('environment');
  });

  it('should create switch client for switches device type', () => {
    const result = VenusClientFactory(mockSettings, 'switches');
    
    expect(result).toBeDefined();
    expect(result.constructor.name).toBe('VenusClient');
    expect(result.settings).toEqual(mockSettings);
    expect(result.deviceType).toBe('switches');
  });

  it('should throw error for unsupported device type', () => {
    expect(() => {
      VenusClientFactory(mockSettings, 'unsupported');
    }).toThrow('Unsupported device type: unsupported');
  });

  it('should pass settings correctly to all client types', () => {
    const deviceTypes = ['batteries', 'tanks', 'environment', 'switches'];
    
    deviceTypes.forEach((deviceType) => {
      const result = VenusClientFactory(mockSettings, deviceType);
      expect(result.settings).toEqual(mockSettings);
      expect(result.deviceType).toBe(deviceType);
    });
  });
});
