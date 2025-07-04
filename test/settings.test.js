import { describe, it, expect } from 'vitest';
import settings from '../settings.js';

describe('Settings Configuration', () => {
  it('should have correct default values', () => {
    expect(settings.venusHost).toBe('venus.local');
    expect(settings.productName).toBe('SignalK Virtual Device');
    expect(settings.interval).toBe(1000);
  });

  it('should have correct enabled devices configuration', () => {
    expect(settings.enabledDevices).toEqual({
      batteries: true,
      tanks: true,
      environment: true,
      switches: true
    });
  });

  it('should have valid regex patterns', () => {
    const { batteryRegex, tankRegex, temperatureRegex, humidityRegex, switchRegex, dimmerRegex } = settings;
    
    // Test battery regex
    expect(batteryRegex.test('electrical.batteries.0.voltage')).toBe(true);
    expect(batteryRegex.test('electrical.batteries.1.current')).toBe(true);
    expect(batteryRegex.test('tanks.fuel.0.level')).toBe(false);
    
    // Test tank regex
    expect(tankRegex.test('tanks.fuel.starboard.currentLevel')).toBe(true);
    expect(tankRegex.test('tanks.freshWater.main.capacity')).toBe(true);
    expect(tankRegex.test('electrical.batteries.0.voltage')).toBe(false);
    
    // Test temperature regex
    expect(temperatureRegex.test('environment.outside.temperature')).toBe(true);
    expect(temperatureRegex.test('propulsion.main.temperature')).toBe(true);
    expect(temperatureRegex.test('environment.outside.humidity')).toBe(false);
    
    // Test humidity regex
    expect(humidityRegex.test('environment.outside.humidity')).toBe(true);
    expect(humidityRegex.test('environment.inside.relativeHumidity')).toBe(true);
    expect(humidityRegex.test('environment.outside.temperature')).toBe(false);
    
    // Test switch regex
    expect(switchRegex.test('electrical.switches.nav.state')).toBe(true);
    expect(switchRegex.test('electrical.switches.anchor.state')).toBe(true);
    expect(switchRegex.test('electrical.switches.nav.dimmingLevel')).toBe(false);
    
    // Test dimmer regex
    expect(dimmerRegex.test('electrical.switches.nav.dimmingLevel')).toBe(true);
    expect(dimmerRegex.test('electrical.switches.cabin.dimmingLevel')).toBe(true);
    expect(dimmerRegex.test('electrical.switches.nav.state')).toBe(false);
  });

  it('should have all required properties', () => {
    const requiredProperties = [
      'venusHost',
      'productName', 
      'interval',
      'enabledDevices',
      'batteryRegex',
      'tankRegex',
      'temperatureRegex',
      'humidityRegex',
      'switchRegex',
      'dimmerRegex'
    ];
    
    requiredProperties.forEach(prop => {
      expect(settings).toHaveProperty(prop);
    });
  });

  it('should have valid types for all properties', () => {
    expect(typeof settings.venusHost).toBe('string');
    expect(typeof settings.productName).toBe('string');
    expect(typeof settings.interval).toBe('number');
    expect(typeof settings.enabledDevices).toBe('object');
    expect(settings.batteryRegex).toBeInstanceOf(RegExp);
    expect(settings.tankRegex).toBeInstanceOf(RegExp);
    expect(settings.temperatureRegex).toBeInstanceOf(RegExp);
    expect(settings.humidityRegex).toBeInstanceOf(RegExp);
    expect(settings.switchRegex).toBeInstanceOf(RegExp);
    expect(settings.dimmerRegex).toBeInstanceOf(RegExp);
  });
});
