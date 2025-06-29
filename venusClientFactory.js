import { VenusClient as BatteryClient } from './venusClient-battery.js';
import { VenusClient as TankClient } from './venusClient-tank.js';
import { VenusClient as EnvClient } from './venusClient-env.js';
import { VenusClient as SwitchClient } from './venusClient-switch.js';

export function VenusClientFactory(settings, deviceType) {
  switch (deviceType) {
    case 'batteries':
      return new BatteryClient(settings, deviceType);
    case 'tanks':
      return new TankClient(settings, deviceType);
    case 'environment':
      return new EnvClient(settings, deviceType);
    case 'switches':
      return new SwitchClient(settings, deviceType);
    default:
      throw new Error(`Unsupported device type: ${deviceType}`);
  }
}
