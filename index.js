import { VenusClientFactory } from './venusClientFactory.js';
import settings from './settings.js';

// Signal K plugin entry point
export default function(app) {
  const plugin = {
    id: 'signalk-to-venus',
    name: 'Signal K to Venus OS Bridge',
    description: 'Bridges Signal K data to Victron Venus OS via D-Bus',
    unsubscribe: null,
    clients: {},
    
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
          default: 'SignalK Virtual Device'
        },
        interval: {
          type: 'number',
          title: 'Update Interval (ms)',
          default: 1000
        },
        enabledDevices: {
          type: 'object',
          title: 'Device Types to Bridge',
          description: 'Select which types of devices should be sent to Venus OS',
          properties: {
            batteries: {
              type: 'boolean',
              title: 'Batteries',
              description: 'Bridge battery voltage, current, SoC, etc.',
              default: true
            },
            tanks: {
              type: 'boolean',
              title: 'Tanks',
              description: 'Bridge tank levels and names',
              default: true
            },
            environment: {
              type: 'boolean',
              title: 'Environment',
              description: 'Bridge temperature and humidity sensors',
              default: true
            },
            switches: {
              type: 'boolean',
              title: 'Switches & Dimmers',
              description: 'Bridge switches and dimmers (bidirectional)',
              default: true
            }
          }
        }
      }
    },

    start: function(options) {
      app.setPluginStatus('Starting Signal K to Venus OS bridge');
      app.debug('Starting Signal K to Venus OS bridge');
      const config = { ...settings, ...options };
      plugin.clients = {};
      const activeClientTypes = new Set();
      let dataUpdateCount = 0;
      
      const deviceTypeNames = {
        'battery': 'Batteries',
        'tank': 'Tanks', 
        'env': 'Environment',
        'switch': 'Switches'
      };

      // Subscribe to Signal K updates using proper plugin API
      const subscriptions = [];
      if (config.enabledDevices?.batteries !== false) {
        subscriptions.push({ path: 'electrical.batteries.*', period: config.interval });
      }
      if (config.enabledDevices?.tanks !== false) {
        subscriptions.push({ path: 'tanks.*', period: config.interval });
      }
      if (config.enabledDevices?.environment !== false) {
        subscriptions.push({ path: 'environment.*', period: config.interval });
      }
      if (config.enabledDevices?.switches !== false) {
        subscriptions.push({ path: 'electrical.switches.*', period: config.interval });
      }

      if (subscriptions.length === 0) {
        app.setPluginStatus('No device types enabled - check plugin configuration');
        return;
      }

      // Subscribe using the correct Signal K plugin API
      plugin.unsubscribe = app.subscriptionmanager.subscribe(
        {
          context: 'vessels.self',
          subscribe: subscriptions
        },
        subscriptions,
        delta => {
          if (delta.updates) {
            delta.updates.forEach(update => {
              update.values.forEach(async pathValue => {
                try {
                  const deviceType = identifyDeviceType(pathValue.path, config);
                  if (deviceType) {
                    if (!plugin.clients[deviceType]) {
                      app.setPluginStatus(`Connecting to Venus OS at ${config.venusHost} for ${deviceTypeNames[deviceType]}`);
                      
                      try {
                        plugin.clients[deviceType] = VenusClientFactory(config, deviceType);
                        
                        // Listen for data updates to show activity
                        plugin.clients[deviceType].on('dataUpdated', (dataType, value) => {
                          dataUpdateCount++;
                          const activeList = Array.from(activeClientTypes).sort().join(', ');
                          app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}] - ${dataUpdateCount} updates`);
                        });
                        
                        await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value);
                        
                        activeClientTypes.add(deviceTypeNames[deviceType]);
                        const activeList = Array.from(activeClientTypes).sort().join(', ');
                        app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}]`);
                        
                      } catch (err) {
                        app.setPluginError(`Venus OS not reachable: ${err.message}`);
                        app.error(`Error connecting to Venus OS for ${deviceType}:`, err);
                        return;
                      }
                    } else {
                      await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value);
                    }
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
      plugin.activeClientTypes = activeClientTypes;
      
      // Set initial status if no data comes in
      setTimeout(() => {
        if (activeClientTypes.size === 0) {
          app.setPluginStatus(`Waiting for Signal K data (${config.venusHost})`);
        }
      }, 2000);
    },

    stop: function() {
      app.setPluginStatus('Stopping Signal K to Venus OS bridge');
      app.debug('Stopping Signal K to Venus OS bridge');
      if (plugin.unsubscribe) {
        plugin.unsubscribe();
      }
      if (plugin.clients) {
        Object.values(plugin.clients).forEach(async client => {
          if (client.disconnect) {
            await client.disconnect();
          }
        });
      }
      app.setPluginStatus('Stopped');
    }
  };

  // Helper function to identify device type from Signal K path
  function identifyDeviceType(path, config) {
    if ((config.enabledDevices?.batteries !== false) && settings.batteryRegex.test(path)) return 'battery';
    if ((config.enabledDevices?.tanks !== false) && settings.tankRegex.test(path)) return 'tank';
    if ((config.enabledDevices?.environment !== false) && (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path))) return 'env';
    if ((config.enabledDevices?.switches !== false) && (settings.switchRegex.test(path) || settings.dimmerRegex.test(path))) return 'switch';
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
