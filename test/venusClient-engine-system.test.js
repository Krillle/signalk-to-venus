import { describe, it, expect, beforeEach } from 'vitest';
import { VenusClient } from '../venusClient.js';

function mockLogger() {
  return {
    debug: () => {},
    error: () => {},
    warn: () => {},
  };
}

describe('VenusClient - Engine and System', () => {
  let engineClient, systemClient;

  beforeEach(() => {
    engineClient = new VenusClient({}, 'engines', mockLogger());
    systemClient = new VenusClient({}, 'system', mockLogger());
    // Mock deviceService
    engineClient.deviceServices.set('propulsion.port', {
      updateProperty: async (path, value, type) => {
        engineClient._lastEngineUpdate = { path, value, type };
        return Promise.resolve();
      },
      basePath: 'propulsion.port',
      deviceData: {},
    });
    systemClient.deviceServices.set('system', {
      updateProperty: async (path, value, type) => {
        systemClient._lastSystemUpdate = { path, value, type };
        return Promise.resolve();
      },
      basePath: 'system',
      deviceData: {},
    });
    engineClient.deviceInstances.set('propulsion.port', { name: 'Engine Port', basePath: 'propulsion.port' });
    systemClient.deviceInstances.set('system', { name: 'System', basePath: 'system' });
  });

  it('should handle engine RPM (revolutions)', async () => {
    await engineClient._handleEngineUpdate('propulsion.port.revolutions', 20, engineClient.deviceServices.get('propulsion.port'), 'Engine Port');
    expect(engineClient._lastEngineUpdate).toMatchObject({ path: '/Engine/0/RPM', value: 1200 });
  });

  it('should handle engine temperature (Kelvin to C)', async () => {
    await engineClient._handleEngineUpdate('propulsion.port.temperature', 373.15, engineClient.deviceServices.get('propulsion.port'), 'Engine Port');
    expect(engineClient._lastEngineUpdate).toMatchObject({ path: '/Engine/0/Temperature', value: 100 });
  });

  it('should handle engine oil pressure (Pa to bar)', async () => {
    await engineClient._handleEngineUpdate('propulsion.port.oilPressure', 200000, engineClient.deviceServices.get('propulsion.port'), 'Engine Port');
    expect(engineClient._lastEngineUpdate).toMatchObject({ path: '/Engine/0/OilPressure', value: 2 });
  });

  it('should handle engine alternator voltage', async () => {
    await engineClient._handleEngineUpdate('propulsion.port.alternatorVoltage', 28.5, engineClient.deviceServices.get('propulsion.port'), 'Engine Port');
    expect(engineClient._lastEngineUpdate).toMatchObject({ path: '/Engine/0/Alternator/Voltage', value: 28.5 });
  });

  it('should handle system speed (m/s to knots)', async () => {
    await systemClient._handleSystemUpdate('navigation.speedOverGround', 10, systemClient.deviceServices.get('system'), 'System');
    expect(systemClient._lastSystemUpdate.path).toBe('/Speed');
    expect(systemClient._lastSystemUpdate.value).toBeCloseTo(19.438444924, 3);
  });

  it('should handle system heading (radians to deg)', async () => {
    await systemClient._handleSystemUpdate('navigation.courseOverGroundTrue', Math.PI, systemClient.deviceServices.get('system'), 'System');
    expect(systemClient._lastSystemUpdate.path).toBe('/Heading/True');
    expect(systemClient._lastSystemUpdate.value).toBeCloseTo(180, 1);
  });

  it('should handle system depth belowKeel (mm to m)', async () => {
    await systemClient._handleSystemUpdate('environment.depth.belowKeel', 2500, systemClient.deviceServices.get('system'), 'System');
    expect(systemClient._lastSystemUpdate).toMatchObject({ path: '/Depth/Depth', value: 2.5 });
  });
  
  it('should handle system depth belowTransducer (mm to m)', async () => {
    await systemClient._handleSystemUpdate('environment.depth.belowTransducer', 3000, systemClient.deviceServices.get('system'), 'System');
    expect(systemClient._lastSystemUpdate).toMatchObject({ path: '/Depth/Depth', value: 3 });
  });
});
