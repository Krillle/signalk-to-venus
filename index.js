import { VenusClientFactory } from './venusClientFactory.js';
import settings from './settings.js';

// Signal K plugin entry point
export default function(app) {
  const plugin = {
    id: 'signalk-to-venus',
    name: 'Signal K to Venus OS Bridge',
    description: 'Bridges Signal K data to Victron Venus OS via D-Bus',
    
    schema: {
      type: 'object',
      properties: {
        venusHost: {
          type: 'string',
          title: 'Venus OS Host',
          default: 'venus.local'
        },
        productName: {
          type: 'string', 
          title: 'Product Name',
          default: 'SignalK Virtual BMV'
        },
        interval: {
          type: 'number',
          title: 'Update Interval (ms)',
          default: 1000
        }
      }
    },

    start: function(options) {
      app.debug('Starting Signal K to Venus OS bridge');
      const config = { ...settings, ...options };
      const clients = {};

      // Subscribe to Signal K updates using proper plugin API
      const subscription = {
        context: 'vessels.self',
        subscribe: [
          { path: 'electrical.batteries.*', period: config.interval },
          { path: 'tanks.*', period: config.interval },
          { path: 'environment.*', period: config.interval },
          { path: 'electrical.switches.*', period: config.interval }
        ]
      };

      app.subscriptionmanager.subscribe(subscription, 
        null, // no err callback
        delta => {
          if (delta.updates) {
            delta.updates.forEach(update => {
              update.values.forEach(async pathValue => {
                try {
                  const deviceType = identifyDeviceType(pathValue.path);
                  if (deviceType) {
                    if (!clients[deviceType]) {
                      clients[deviceType] = VenusClientFactory(config, deviceType);
                    }
                    await clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value);
                  }
                } catch (err) {
                  app.error(`Error handling path ${pathValue.path}:`, err);
                }
              });
            });
          }
        }
      );

      // Handle venus client value changes by setting values back to Signal K
      Object.values(clients).forEach(client => {
        client.on('valueChanged', async (venusPath, value) => {
          try {
            const signalKPath = mapVenusToSignalKPath(venusPath);
            if (signalKPath) {
              // Use Signal K's internal API instead of external PUT
              await app.putSelfPath(signalKPath, value, 'venus-bridge');
              app.debug(`Updated Signal K path ${signalKPath} with value ${value}`);
            }
          } catch (err) {
            app.error(`Error updating Signal K path from venus ${venusPath}:`, err);
          }
        });
      });

      plugin.clients = clients;
      plugin.subscription = subscription;
    },

    stop: function() {
      app.debug('Stopping Signal K to Venus OS bridge');
      if (plugin.subscription) {
        app.subscriptionmanager.unsubscribe(plugin.subscription);
      }
      if (plugin.clients) {
        Object.values(plugin.clients).forEach(async client => {
          if (client.disconnect) {
            await client.disconnect();
          }
        });
      }
    }
  };

  // Helper function to identify device type from Signal K path
  function identifyDeviceType(path) {
    if (settings.batteryRegex.test(path)) return 'battery';
    if (settings.tankRegex.test(path)) return 'tank';
    if (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path)) return 'env';
    if (settings.switchRegex.test(path) || settings.dimmerRegex.test(path)) return 'switch';
    return null;
  }

  // Helper function to map Venus D-Bus paths back to Signal K paths
  function mapVenusToSignalKPath(venusPath) {
    // This would need proper mapping logic based on your venus client implementations
    // For switches/dimmers that support bidirectional updates
    if (venusPath.includes('/Switches/')) {
      const id = venusPath.match(/\/Switches\/([^\/]+)/)?.[1];
      if (venusPath.endsWith('/State')) {
        return `electrical.switches.${id}.state`;
      } else if (venusPath.endsWith('/DimLevel')) {
        return `electrical.switches.${id}.dimmingLevel`;
      }
    }
    return null;
  }

  return plugin;
}
