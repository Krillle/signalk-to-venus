import { VenusClientFactory } from './venusClientFactory.js';
import settings from './settings.js';
import dbus from 'dbus-next';

// Signal K plugin entry point
export default function(app) {
  // Dynamic tracking of discovered Signal K paths
  let discoveredPaths = {
    batteries: new Map(),
    tanks: new Map(), 
    environment: new Map(),
    switches: new Map()
  };
  let lastSchemaUpdate = 0;
  
  const plugin = {
    id: 'signalk-to-venus',
    name: 'Signal K to Venus OS Bridge',
    description: 'Bridges Signal K data to Victron Venus OS via D-Bus',
    unsubscribe: null,
    clients: {},
    connectivityInterval: null,
    
    // Function to generate dynamic schema based on discovered paths
    schema: function() {
      const baseSchema = {
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
      };

      // Add dynamic path configuration if paths have been discovered
      if (hasDiscoveredPaths()) {
        baseSchema.properties.pathConfiguration = {
          type: 'object',
          title: 'Individual Signal K Path Configuration',
          description: 'Configure individual Signal K paths discovered on your boat',
          properties: {}
        };

        // Add each device type with discovered paths
        Object.entries(discoveredPaths).forEach(([deviceType, pathMap]) => {
          if (pathMap.size > 0) {
            const deviceTitle = deviceType.charAt(0).toUpperCase() + deviceType.slice(1);
            baseSchema.properties.pathConfiguration.properties[deviceType] = {
              type: 'object',
              title: `${deviceTitle} Paths`,
              description: `Configure individual ${deviceType} found on your boat`,
              properties: {}
            };

            // Add each discovered path
            pathMap.forEach((pathInfo, path) => {
              const safePathKey = path.replace(/[^a-zA-Z0-9]/g, '_');
              baseSchema.properties.pathConfiguration.properties[deviceType].properties[safePathKey] = {
                type: 'object',
                title: pathInfo.displayName || path,
                properties: {
                  enabled: {
                    type: 'boolean',
                    title: 'Enabled',
                    description: `Bridge this ${deviceType.slice(0, -1)} to Venus OS`,
                    default: pathInfo.enabled !== false
                  },
                  customName: {
                    type: 'string',
                    title: 'Custom Name',
                    description: 'Optional custom name for this device in Venus OS',
                    default: pathInfo.customName || ''
                  },
                  _pathInfo: {
                    type: 'string',
                    title: 'Signal K Path',
                    description: 'The actual Signal K path (read-only)',
                    default: path,
                    readOnly: true
                  }
                }
              };
            });
          }
        });
      }

      return baseSchema;
    },

    // UI Schema to enhance the configuration interface
    uiSchema: function() {
      const uiSchema = {
        enabledDevices: {
          'ui:field': 'collapsible',
          collapse: {
            field: 'ObjectField',
            wrapClassName: 'panel-group'
          }
        }
      };

      // Add UI enhancements for path configuration if it exists
      if (hasDiscoveredPaths()) {
        uiSchema.pathConfiguration = {
          'ui:field': 'collapsible',
          collapse: {
            field: 'ObjectField',
            wrapClassName: 'panel-group'
          }
        };

        // Make each device type collapsible
        Object.keys(discoveredPaths).forEach(deviceType => {
          if (discoveredPaths[deviceType].size > 0) {
            uiSchema.pathConfiguration[deviceType] = {
              'ui:field': 'collapsible',
              collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
              }
            };

            // Make individual path configurations more compact
            discoveredPaths[deviceType].forEach((pathInfo, path) => {
              const safePathKey = path.replace(/[^a-zA-Z0-9]/g, '_');
              uiSchema.pathConfiguration[deviceType][safePathKey] = {
                'ui:field': 'collapsible',
                collapse: {
                  field: 'ObjectField',
                  wrapClassName: 'panel-group'
                },
                enabled: {
                  'ui:widget': 'checkbox'
                },
                customName: {
                  'ui:placeholder': 'Enter custom name (optional)'
                },
                _pathInfo: {
                  'ui:readonly': true,
                  'ui:widget': 'textarea',
                  'ui:options': {
                    rows: 1
                  }
                }
              };
            });
          }
        });
      }

      return uiSchema;
    },

    start: function(options) {
      app.setPluginStatus('Starting Signal K to Venus OS bridge');
      app.debug('Starting Signal K to Venus OS bridge');
      const config = { ...settings, ...options };
      plugin.clients = {};
      const activeClientTypes = new Set();
      let dataUpdateCount = 0;
      let heartbeatToggle = false; // For alternating heartbeat display
      let venusReachable = null; // Track Venus OS reachability
      
      const deviceTypeNames = {
        'battery': 'Batteries',
        'tank': 'Tanks', 
        'env': 'Environment',
        'switch': 'Switches'
      };

      // Test Venus OS connectivity before processing any data
      async function testVenusConnectivity() {
        let testBus = null;
        let originalAddress = null;
        
        try {
          // Simple connectivity test using dbus-next connection test
          originalAddress = process.env.DBUS_SYSTEM_BUS_ADDRESS;
          process.env.DBUS_SYSTEM_BUS_ADDRESS = `tcp:host=${config.venusHost},port=78`;
          
          testBus = dbus.systemBus();
          
          // Try to connect with a short timeout
          const testPromise = testBus.requestName('com.victronenergy.test.connectivity');
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout')), 3000)
          );
          
          await Promise.race([testPromise, timeoutPromise]);
          
          venusReachable = true;
          app.setPluginStatus(`Venus OS reachable at ${config.venusHost}`);
          return true;
        } catch (err) {
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
        } finally {
          // Always disconnect the test bus and restore environment
          if (testBus) {
            try {
              await testBus.disconnect();
            } catch (disconnectErr) {
              // Silent disconnect error handling
            }
          }
          
          // Restore original D-Bus address
          if (originalAddress) {
            process.env.DBUS_SYSTEM_BUS_ADDRESS = originalAddress;
          } else {
            delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
          }
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
            
            // Skip null/undefined values at the source - don't process them at all
            if (data.value === null || data.value === undefined) {
              return;
            }
            
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
        } catch (err) {
          app.error('Connectivity test error:', err);
        }
      }
      
      runConnectivityTest(); // Run initial test
      plugin.connectivityInterval = setInterval(runConnectivityTest, 60000); // Check every 60 seconds (reduced frequency)
      
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
                    return;
                  }
                  
                  if (!pathValue.path) {
                    return;
                  }
                  
                  // Skip null/undefined values - this should be rare if streambundle filtering works
                  if (pathValue.value === undefined || pathValue.value === null) {
                    return;
                  }
                
                const deviceType = identifyDeviceType(pathValue.path, config);
                if (deviceType) {
                  // Track this discovered path
                  addDiscoveredPath(deviceType, pathValue.path, pathValue.value);
                  
                  // Check if this specific path is enabled
                  if (!isPathEnabled(deviceType, pathValue.path, config)) {
                    return; // Skip disabled paths
                  }
                  
                  if (!plugin.clients[deviceType]) {
                    app.setPluginStatus(`Connecting to Venus OS at ${config.venusHost} for ${deviceTypeNames[deviceType]}`);
                    
                    try {
                      plugin.clients[deviceType] = VenusClientFactory(config, deviceType);
                      
                      // Listen for data updates to show activity with heartbeat
                      plugin.clients[deviceType].on('dataUpdated', (dataType, value) => {
                        dataUpdateCount++;
                        heartbeatToggle = !heartbeatToggle; // Alternate heartbeat
                        const heartbeat = heartbeatToggle ? '♥︎' : '♡';
                        const activeList = Array.from(activeClientTypes).sort().join(', ');
                        app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}] ${heartbeat}`);
                      });
                      
                      await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value, getCustomName(deviceType, pathValue.path, config));
                      
                      activeClientTypes.add(deviceTypeNames[deviceType]);
                      const activeList = Array.from(activeClientTypes).sort().join(', ');
                      app.setPluginStatus(`Connected to Venus OS at ${config.venusHost} for [${activeList}]`);
                      
                    } catch (err) {
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
                      return;
                    }
                    
                    try {
                      await plugin.clients[deviceType].handleSignalKUpdate(pathValue.path, pathValue.value, getCustomName(deviceType, pathValue.path, config));
                    } catch (err) {
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

  // Helper function to check if any paths have been discovered
  function hasDiscoveredPaths() {
    return Object.values(discoveredPaths).some(pathMap => pathMap.size > 0);
  }

  // Function to add a discovered path to tracking
  function addDiscoveredPath(deviceType, path, value) {
    const pathMap = discoveredPaths[deviceType];
    if (!pathMap) return;

    if (!pathMap.has(path)) {
      // Generate a human-readable display name
      let displayName = generateDisplayName(deviceType, path);
      
      pathMap.set(path, {
        displayName: displayName,
        enabled: true, // Default to enabled
        customName: '',
        firstSeen: new Date().toISOString(),
        lastValue: value,
        sampleValue: value
      });

      // Trigger schema update if enough time has passed
      const now = Date.now();
      if (now - lastSchemaUpdate > 5000) { // Throttle updates to every 5 seconds
        lastSchemaUpdate = now;
        
        // Notify Signal K that the schema has changed (if supported)
        if (app.handleMessage && typeof app.handleMessage === 'function') {
          try {
            app.handleMessage(plugin.id, {
              type: 'schema-update',
              timestamp: new Date().toISOString()
            });
          } catch (err) {
            // Schema update notification not supported, ignore
          }
        }
      }
      
      app.debug(`Discovered new ${deviceType} path: ${path} (${displayName})`);
    } else {
      // Update last seen value
      pathMap.get(path).lastValue = value;
    }
  }

  // Function to generate human-readable display names
  function generateDisplayName(deviceType, path) {
    switch (deviceType) {
      case 'batteries':
        const batteryMatch = path.match(/electrical\.batteries\.(\d+|[^.]+)\./);
        if (batteryMatch) {
          return `Battery ${batteryMatch[1]}`;
        }
        break;
        
      case 'tanks':
        const tankMatch = path.match(/tanks\.([^.]+)\.(\d+|[^.]+)\./);
        if (tankMatch) {
          const tankType = tankMatch[1].replace(/([A-Z])/g, ' $1').toLowerCase();
          const tankId = tankMatch[2];
          return `${tankType.charAt(0).toUpperCase() + tankType.slice(1)} Tank ${tankId}`;
        }
        break;
        
      case 'environment':
        if (path.includes('temperature')) {
          const tempMatch = path.match(/environment\.([^.]+)\.temperature|propulsion\.([^.]+)\.temperature/);
          if (tempMatch) {
            const sensor = tempMatch[1] || tempMatch[2];
            return `Temperature - ${sensor.charAt(0).toUpperCase() + sensor.slice(1)}`;
          }
        } else if (path.includes('humidity') || path.includes('relativeHumidity')) {
          const humMatch = path.match(/environment\.([^.]+)\.(humidity|relativeHumidity)/);
          if (humMatch) {
            const sensor = humMatch[1];
            return `Humidity - ${sensor.charAt(0).toUpperCase() + sensor.slice(1)}`;
          }
        }
        break;
        
      case 'switches':
        const switchMatch = path.match(/electrical\.switches\.([^.]+)\.(state|dimmingLevel)/);
        if (switchMatch) {
          const switchId = switchMatch[1];
          const type = switchMatch[2] === 'dimmingLevel' ? 'Dimmer' : 'Switch';
          return `${type} ${switchId}`;
        }
        break;
    }
    
    // Fallback to path-based name
    return path.split('.').pop() || path;
  }

  // Function to check if a path is enabled in configuration
  function isPathEnabled(deviceType, path, config) {
    // Check if device type is enabled
    if (config.enabledDevices?.[deviceType] === false) {
      return false;
    }

    // Check individual path configuration if it exists
    if (config.pathConfiguration?.[deviceType]) {
      const safePathKey = path.replace(/[^a-zA-Z0-9]/g, '_');
      const pathConfig = config.pathConfiguration[deviceType][safePathKey];
      if (pathConfig && pathConfig.enabled === false) {
        return false;
      }
    }

    return true;
  }

  // Function to get custom name for a path
  function getCustomName(deviceType, path, config) {
    if (config.pathConfiguration?.[deviceType]) {
      const safePathKey = path.replace(/[^a-zA-Z0-9]/g, '_');
      const pathConfig = config.pathConfiguration[deviceType][safePathKey];
      if (pathConfig && pathConfig.customName) {
        return pathConfig.customName;
      }
    }
    return null;
  }

  return plugin;
}