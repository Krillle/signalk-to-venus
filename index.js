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

      // Subscribe to Signal K delta stream using multiple approaches for compatibility
      app.setPluginStatus('Setting up Signal K subscription...');
      app.error('Plugin debug: Setting up subscription');
      app.error('Plugin debug: app.streambundle available:', !!app.streambundle);
      app.error('Plugin debug: app.signalk available:', !!app.signalk);
      app.error('Plugin debug: app.registerDeltaInputHandler available:', !!app.registerDeltaInputHandler);
      let deltaCount = 0;
      let lastDataTime = Date.now();
      
      // Try multiple subscription methods in order of compatibility
      if (app.streambundle && app.streambundle.getSelfBus) {
        // Method 1: Stream bundle getSelfBus (correct API usage)
        try {
          // Subscribe to all paths and filter in the callback
          plugin.unsubscribe = app.streambundle.getSelfBus().onValue(data => {
            // Convert the normalized delta format to standard delta format
            const delta = {
              context: data.context,
              updates: [{
                source: data.source,
                timestamp: data.timestamp,
                values: [{
                  path: data.path,
                  value: data.value
                }]
              }]
            };
            processDelta(delta);
          });
          app.error('Plugin debug: Using streambundle getSelfBus method');
        } catch (err) {
          app.error('getSelfBus method failed:', err);
        }
      } else if (app.signalk && app.signalk.subscribe) {
        // Method 2: Direct signalk subscription (common method)
        try {
          const subscription = {
            context: 'vessels.self',
            subscribe: [
              { path: '*', period: config.interval, format: 'delta', policy: 'ideal', minPeriod: 200 }
            ]
          };
          plugin.unsubscribe = app.signalk.subscribe(subscription, delta => {
            processDelta(delta);
          });
          app.error('Plugin debug: Using signalk.subscribe method');
        } catch (err) {
          app.error('signalk.subscribe method failed:', err);
        }
      } else if (app.registerDeltaInputHandler) {
        // Method 3: Delta input handler (fallback)
        try {
          app.registerDeltaInputHandler((delta, next) => {
            if (delta.context === 'vessels.self') {
              processDelta(delta);
            }
            next(delta);
          });
          app.error('Plugin debug: Using registerDeltaInputHandler method');
        } catch (err) {
          app.error('registerDeltaInputHandler method failed:', err);
        }
      } else {
        app.setPluginError('No compatible subscription method found');
        return;
      }
      
      // Function to process delta messages
      function processDelta(delta) {
        deltaCount++;
        lastDataTime = Date.now();
        if (deltaCount <= 3) {
          app.error(`Plugin debug: Delta #${deltaCount} received with ${delta.updates?.length || 0} updates`);
        }
        
        if (delta.updates) {
          delta.updates.forEach(update => {
            update.values.forEach(async pathValue => {
              if (deltaCount <= 5) {
                app.error(`Plugin debug: Processing path: ${pathValue.path}`);
              }
              try {
                const deviceType = identifyDeviceType(pathValue.path, config);
                if (deviceType) {
                  app.error(`Plugin debug: ✅ Matched ${pathValue.path} as ${deviceType} device`);
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
                } else {
                  if (deltaCount <= 5) {
                    app.error(`Plugin debug: ❌ No device type match for path: ${pathValue.path}`);
                  }
                }
              } catch (err) {
                app.error(`Error handling path ${pathValue.path}:`, err);
              }
            });
          });
        }
      }

      // Monitor subscription health
      setTimeout(() => {
        if (deltaCount === 0) {
          app.error('Plugin debug: No deltas received after 5 seconds - delta stream may not be working');
          app.setPluginStatus(`No Signal K data received - check server configuration`);
        }
      }, 5000);

      // Handle venus client value changes by setting values back to Signal K
      Object.values(plugin.clients).forEach(client => {
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
