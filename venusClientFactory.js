import { VenusClient as BatteryClient } from './venusClient-battery.js';
import { VenusClient as TankClient } from './venusClient-tank.js';
import { VenusClient as EnvClient } from './venusClient-env.js';
import { VenusClient as SwitchClient } from './venusClient-switch.js';

export function VenusClientFactory(settings, deviceType) {
  switch (deviceType) {
    case 'battery':
      return new BatteryClient(settings, deviceType);
    case 'tank':
      return new TankClient(settings, deviceType);
    case 'env':
      return new EnvClient(settings, deviceType);
    case 'switch':
      return new SwitchClient(settings, deviceType);
    default:
      throw new Error(`Unsupported device type: ${deviceType}`);
  }
}
