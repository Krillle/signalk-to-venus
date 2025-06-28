import { VenusClientFactory } from './venusClientFactory.js';
import settings from './settings.js';
import dbus from 'dbus-next';

// Signal K plugin entry point
export default function(app) {
  const plugin = {
    id: 'signalk-to-venus',
    name: 'Signal K to Venus OS Bridge',
    description: 'Bridges Signal K data to Victron Venus OS via D-Bus',
    unsubscribe: null,
    clients: {},
    connectivityInterval: null,
    
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
      let venusReachable = null; // Track Venus OS reachability
      
      const deviceTypeNames = {
        'battery': 'Batteries',
        'tank': 'Tanks', 
        'env': 'Environment',
        'switch': 'Switches'
      };

      // Test Venus OS connectivity before processing any data
      async function testVenusConnectivity() {
        app.debug('Running Venus OS connectivity test...');
        try {
          // Simple connectivity test using dbus-next connection test
          const testBus = dbus.systemBus();
          const originalAddress = process.env.DBUS_SYSTEM_BUS_ADDRESS;
          process.env.DBUS_SYSTEM_BUS_ADDRESS = `tcp:host=${config.venusHost},port=78`;
          
          app.debug(`Testing connection to ${config.venusHost}:78`);
          
          // Try to connect with a short timeout
          const testPromise = testBus.requestName('com.victronenergy.test.connectivity');
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), 3000)
          );
          
          await Promise.race([testPromise, timeoutPromise]);
          await testBus.disconnect();
          
          // Restore original address
          if (originalAddress) {
            process.env.DBUS_SYSTEM_BUS_ADDRESS = originalAddress;
          } else {
            delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
          }
          
          venusReachable = true;
          app.setPluginStatus(`Venus OS reachable at ${config.venusHost}`);
          return true;
        } catch (err) {
          // Restore original address on error
          if (process.env.DBUS_SYSTEM_BUS_ADDRESS.includes('tcp:')) {
            delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
          }
          
          venusReachable = false;
          let errorMsg = `Venus OS not reachable at ${config.venusHost}`;
          
          if (err.code === 'ENOTFOUND') {
            errorMsg += ' (DNS resolution failed)';
          } else if (err.code === 'ECONNREFUSED') {
            errorMsg += ' (connection refused - check D-Bus TCP setting)';
          } else if (err.message.includes('timeout')) {
            errorMsg += ' (connection timeout)';
          }
          
          app.setPluginError(errorMsg);
          
          // Clear all existing clients when Venus becomes unreachable
          Object.keys(plugin.clients).forEach(key => {
            if (plugin.clients[key] && typeof plugin.clients[key] === 'object') {
              // Disconnect existing clients gracefully
              if (plugin.clients[key].disconnect) {
                plugin.clients[key].disconnect().catch(() => {});
              }
            }
            delete plugin.clients[key];
          });
          
          return false;
        }
      }

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
      app.setPluginStatus('Setting up Signal K subscription');
      let deltaCount = 0;
      let lastDataTime = Date.now();
      
      // Try multiple subscription methods in order of compatibility
      if (app.streambundle && app.streambundle.getSelfBus) {
        // Method 1: Stream bundle getSelfBus (correct API usage)
        try {
          // Subscribe to all paths and filter in the callback
          plugin.unsubscribe = app.streambundle.getSelfBus().onValue(data => {
            // Validate the streambundle data before conversion
            if (!data || typeof data !== 'object' || !data.path) {
              app.debug(`Invalid streambundle data:`, data);
              return;
            }
            
            // Filter paths early - only process paths we care about
            const deviceType = identifyDeviceType(data.path, config);
            if (!deviceType) {
              // Path doesn't match any enabled device types, skip silently
              return;
            }
            
            app.debug(`STREAMBUNDLE: Found matching path ${data.path} for ${deviceType}`);
            
            // Skip null/undefined values at the source - don't process them at all
            if (data.value === null || data.value === undefined) {
              app.debug(`STREAMBUNDLE: Filtered out null/undefined value for ${data.path} (value: ${data.value})`);
              return;
            }
            
            app.debug(`STREAMBUNDLE: Processing valid value for ${data.path}:`, data.value);
            
            // Convert the normalized delta format to standard delta format
            const delta = {
              context: data.context || 'vessels.self',
              updates: [{
                source: data.source || { label: 'streambundle' },
                timestamp: data.timestamp || new Date().toISOString(),
                values: [{
                  path: data.path,
                  value: data.value
                }]
              }]
            };
            
            processDelta(delta);
          });
          app.debug('Successfully subscribed to streambundle - null values filtered at source');
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
          app.debug('Successfully subscribed to signalk.subscribe');
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
          app.debug('Successfully subscribed to registerDeltaInputHandler');
        } catch (err) {
          app.error('registerDeltaInputHandler method failed:', err);
        }
      } else {
        app.setPluginError('No compatible subscription method found');
        return;
      }
      
      // Test Venus OS connectivity initially and periodically
      async function runConnectivityTest() {
        try {
          const isReachable = await testVenusConnectivity();
          app.debug(`Venus connectivity test result: ${isReachable}`);
        } catch (err) {
          app.error('Connectivity test error:', err);
        }
      }
      
      runConnectivityTest(); // Run initial test
      plugin.connectivityInterval = setInterval(runConnectivityTest, 30000); // Check every 30 seconds
      
      // Function to process delta messages
      function processDelta(delta) {
        try {
          deltaCount++;
          lastDataTime = Date.now();
          
          // Check Venus reachability before processing any data
          if (venusReachable === false) {
            // Venus OS is known to be unreachable, skip all processing
            return;
          }
          
          if (delta.updates) {
            delta.updates.forEach(update => {
              // Check if update and update.values are valid
              if (!update || !Array.isArray(update.values)) {
                app.debug(`Skipping invalid update:`, update);
                return;
              }
              
              update.values.forEach(async pathValue => {
                try {
                  // Check if pathValue exists and has required properties
                  if (!pathValue || typeof pathValue !== 'object') {
                    app.debug(`Skipping invalid pathValue:`, pathValue);
                    return;
                  }
                  
                  if (!pathValue.path) {
                    app.debug(`Skipping pathValue without path:`, pathValue);
                    return;
                  }
                  
                  // Debug the incoming Signal K data - this should be rare if streambundle filtering works
                  if (pathValue.value === undefined || pathValue.value === null) {
                    app.debug(`DELTA PROCESSING: Still receiving null/undefined for ${pathValue.path} - value is ${pathValue.value}`);
                    app.debug(`Full pathValue object:`, pathValue);
                    return;
                  }
                
                const deviceType = identifyDeviceType(pathValue.path, config);
                if (deviceType) {
                  app.debug(`Processing ${pathValue.path} as ${deviceType} with value:`, pathValue.value);
                  
                  if (!plugin.clients[deviceType]) {
                    app.setPluginStatus(`Connecting to Venus OS at ${config.venusHost} for ${deviceTypeNames[deviceType]}`);
                    
                    try {
                      app.debug(`Creating new ${deviceType} client for Venus OS`);
                      plugin.clients[deviceType] = VenusClientFactory(config, deviceType);
                      
                      // Listen for data updates to show activity
                      plugin.clients[deviceType].on('dataUpdated', (dataType, value) => {
                        dataUpdateCount++;
                        const activeList = Array.from(activeClientTypes).sort().join(', ');
                        app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}] - ${dataUpdateCount} updates`);
                      });
                      
                      app.debug(`Calling handleSignalKUpdate on new ${deviceType} client`);
                      app.debug(`Arguments: path="${pathValue.path}", value=`, pathValue.value);
                      await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value);
                      
                      activeClientTypes.add(deviceTypeNames[deviceType]);
                      const activeList = Array.from(activeClientTypes).sort().join(', ');
                      app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}]`);
                      
                    } catch (err) {
                      app.error(`ERROR CREATING CLIENT: ${err.message}`, err.stack);
                      // Clean up connection error messages for better user experience
                      let cleanMessage = err.message || err.toString();
                      if (cleanMessage.includes('ENOTFOUND')) {
                        cleanMessage = `Venus OS device not found at ${config.venusHost} (DNS resolution failed)`;
                      } else if (cleanMessage.includes('ECONNREFUSED')) {
                        cleanMessage = `Venus OS device refused connection at ${config.venusHost}:78 (check D-Bus TCP setting)`;
                      } else if (cleanMessage.includes('timeout')) {
                        cleanMessage = `Venus OS connection timeout (${config.venusHost}:78)`;
                      }
                      
                      app.setPluginError(`Venus OS not reachable: ${cleanMessage}`);
                      
                      // Mark this client as failed to prevent retries
                      plugin.clients[deviceType] = null;
                      
                      // Only log the first connection error per device type to avoid spam
                      if (!plugin.clients[`${deviceType}_error_logged`]) {
                        app.error(`Cannot connect to Venus OS for ${deviceTypeNames[deviceType]}: ${cleanMessage}`);
                        plugin.clients[`${deviceType}_error_logged`] = true;
                      }
                      return;
                    }
                  } else {
                    // Client already exists - but check if it's null (failed connection)
                    if (plugin.clients[deviceType] === null) {
                      app.debug(`Skipping ${pathValue.path} - client marked as failed`);
                      return;
                    }
                    
                    app.debug(`Calling handleSignalKUpdate on existing ${deviceType} client`);
                    app.debug(`Arguments: path="${pathValue.path}", value=`, pathValue.value);
                    try {
                      await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value);
                    } catch (err) {
                      app.error(`ERROR ON EXISTING CLIENT: ${err.message}`, err.stack);
                      // Only log detailed errors if it's not a connection issue
                      if (err.message && (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED'))) {
                        // Suppress frequent connection errors when Venus OS is not available
                        // The main connection error is already logged during client creation
                        
                        // Mark client as failed
                        plugin.clients[deviceType] = null;
                      } else {
                        app.error(`Error updating ${deviceType} client for ${pathValue.path}: ${err.message}`);
                      }
                    }
                  }
                }
              } catch (err) {
                // Only log unexpected errors, suppress common connection errors
                if (!err.message || (!err.message.includes('ENOTFOUND') && !err.message.includes('ECONNREFUSED'))) {
                  app.error(`Unexpected error processing ${pathValue.path}: ${err.message}`);
                }
              }
            });
          });
        }
        } catch (err) {
          app.error('Error processing delta:', err);
        }
      }

      // Monitor subscription health
      setTimeout(() => {
        if (deltaCount === 0) {
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
      
      // Clear connectivity interval
      if (plugin.connectivityInterval) {
        clearInterval(plugin.connectivityInterval);
      }
      
      if (plugin.unsubscribe) {
        plugin.unsubscribe();
      }
      if (plugin.clients) {
        Object.values(plugin.clients).forEach(async client => {
          if (client && client.disconnect) {
            await client.disconnect();
          }
        });
      }
      app.setPluginStatus('Stopped');
    }
  };

  // Helper function to identify device type from Signal K path
  function identifyDeviceType(path, config) {
    // Filter out Cerbo GX relays (venus-0, venus-1) to prevent feedback loops
    if (path.match(/electrical\.switches\.venus-[01]\./)) {
      app.debug(`Skipping Cerbo GX relay path: ${path}`);
      return null;
    }
    
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
      
      // Filter out Cerbo GX relays to prevent feedback loops
      if (id === 'venus-0' || id === 'venus-1') {
        return null;
      }
      
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
