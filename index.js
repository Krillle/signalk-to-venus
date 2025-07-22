import { VenusClientFactory } from './venusClientFactory.js';
import settings from './settings.js';
import dbusNative from 'dbus-native';

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
    venusConnected: false,
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
          }
        }
      };

      // Add discovered devices grouped by type if any have been found
      if (hasDiscoveredPaths()) {
        // Add each device type with discovered paths
        Object.entries(discoveredPaths).forEach(([deviceType, pathMap]) => {
          if (pathMap.size > 0) {
            const deviceTitles = {
              'batteries': 'Batteries',
              'tanks': 'Tanks',
              'environment': 'Environment',
              'switches': 'Switches & Dimmers'
            };
            
            baseSchema.properties[deviceType] = {
              type: 'object',
              title: deviceTitles[deviceType],
              properties: {}
            };

            // Add each discovered path as a simple checkbox
            pathMap.forEach((pathInfo, devicePath) => {
              const safePathKey = devicePath.replace(/[^a-zA-Z0-9]/g, '_');
              baseSchema.properties[deviceType].properties[safePathKey] = {
                type: 'boolean',
                title: `${pathInfo.displayName} (${devicePath})`,
                default: false // Disable devices by default to prevent unwanted connections
              };
            });
          }
        });
      }

      return baseSchema;
    },

    // UI Schema to enhance the configuration interface
    uiSchema: function() {
      const uiSchema = {};

      // Make each device type collapsible if devices have been discovered
      if (hasDiscoveredPaths()) {
        Object.keys(discoveredPaths).forEach(deviceType => {
          if (discoveredPaths[deviceType].size > 0) {
            uiSchema[deviceType] = {
              'ui:field': 'collapsible',
              collapse: {
                field: 'ObjectField',
                wrapClassName: 'panel-group'
              }
            };
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
      plugin.venusConnected = false; // Track Venus connection status
      const activeClientTypes = new Set();
      let venusReachable = false; // Track Venus OS reachability (assume unreachable until proven otherwise)
      
      // Queue for paths that arrive before Venus OS is ready
      const pendingPaths = [];
      let isProcessingQueue = false;
      
      const deviceTypeNames = {
        'batteries': 'Batteries',
        'tanks': 'Tanks', 
        'environment': 'Environment',
        'switches': 'Switches'
      };

      // Function to check if Signal K has populated any device data
      async function waitForSignalKReadiness() {
        app.setPluginStatus('Waiting for Signal K to populate data...');
        
        const maxWaitTime = 15000; // Reduced to 15 seconds - we just need Signal K to be generally ready
        const checkInterval = 1000; // Check every 1 second
        let waitTime = 0;
        
        return new Promise((resolve) => {
          const checkReadiness = () => {
            try {
              // Check if Signal K has any data available at all (not specific device types)
              let hasSignalKData = false;
              
              // Try to get the root vessel data to see if Signal K is populated
              if (app.getSelfPath) {
                try {
                  const rootData = app.getSelfPath('');
                  if (rootData && typeof rootData === 'object' && Object.keys(rootData).length > 0) {
                    hasSignalKData = true;
                  }
                } catch (err) {
                  // getSelfPath might fail if data isn't ready yet
                }
              }
              
              // Also check if we have a streambundle with any data
              if (!hasSignalKData && app.streambundle && app.streambundle.getSelfStream) {
                try {
                  const stream = app.streambundle.getSelfStream('');
                  if (stream && stream.value && typeof stream.value === 'object' && Object.keys(stream.value).length > 0) {
                    hasSignalKData = true;
                  }
                } catch (err) {
                  // Stream might not be ready
                }
              }
              
              // If we still don't have data, check if the app has basic vessel info
              if (!hasSignalKData && app.getSelfPath) {
                try {
                  // Check for basic vessel information that should always be present
                  const vesselInfo = app.getSelfPath('design') || app.getSelfPath('navigation') || app.getSelfPath('name');
                  if (vesselInfo) {
                    hasSignalKData = true;
                  }
                } catch (err) {
                  // Ignore errors, we'll timeout if needed
                }
              }
              
              if (hasSignalKData || waitTime >= maxWaitTime) {
                if (hasSignalKData) {
                  app.setPluginStatus('Signal K data ready, starting device discovery...');
                } else {
                  app.setPluginStatus('Signal K readiness timeout, starting discovery anyway...');
                }
                resolve();
              } else {
                waitTime += checkInterval;
                setTimeout(checkReadiness, checkInterval);
              }
            } catch (err) {
              app.debug('Error checking Signal K readiness:', err);
              // Continue anyway after a short delay
              setTimeout(() => resolve(), 1000);
            }
          };
          
          // Start checking after a short initial delay to let Signal K initialize
          setTimeout(checkReadiness, 1000);
        });
      }

      // Test Venus OS connectivity before processing any data
      async function testVenusConnectivity() {
        let testBus = null;
        
        try {          
          // Create D-Bus connection with anonymous authentication for Venus OS using dbus-native
          try {
            testBus = dbusNative.createClient({
              host: config.venusHost,
              port: 78,
              authMethods: ['ANONYMOUS'] // Try anonymous auth first for Venus OS
            });
          } catch (createErr) {
            throw createErr;
          }
          
          // Test the connection by trying to list names (simple D-Bus operation)
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Connection timeout'));
            }, 3000);
            
            // Try a simple D-Bus operation to test connectivity
            try {
              testBus.listNames((err, names) => {
                clearTimeout(timeout);
                if (err) {
                  reject(err);
                } else {
                  resolve();
                }
              });
            } catch (syncErr) {
              clearTimeout(timeout);
              reject(syncErr);
            }
          });
          
          venusReachable = true;
          plugin.venusConnected = true;
          app.setPluginStatus(`Venus OS reachable at ${config.venusHost} - waiting for data to stabilize...`);
          
          // Wait 5 seconds after Venus becomes reachable to let Signal K data fully populate
          await new Promise(resolve => setTimeout(resolve, 5000));
          app.setPluginStatus(`Venus OS ready at ${config.venusHost}`);
          
          return true;
        } catch (err) {
          venusReachable = false;
          plugin.venusConnected = false;
          let errorMsg = `Venus OS not reachable at ${config.venusHost}`;
          
          if (err.code === 'ENOTFOUND') {
            errorMsg += ' (DNS resolution failed)';
          } else if (err.code === 'ECONNREFUSED') {
            errorMsg += ' (connection refused - check D-Bus TCP setting)';
          } else if (err.message.includes('timeout')) {
            errorMsg += ' (connection timeout)';
          } else if (err.message.includes('dbus-keyrings') || err.message.includes('ENOENT')) {
            errorMsg += ' (D-Bus authentication failed - this is a known issue)';
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
          // Always disconnect the test bus
          if (testBus) {
            try {
              testBus.end();
            } catch (disconnectErr) {
              // Silent disconnect error handling
            }
          }
        }
      }

      // Main startup sequence - wait for Signal K to be ready
      async function startBridge() {
        try {
          // Wait for Signal K to populate device data
          await waitForSignalKReadiness();
          
          // Test Venus OS connectivity initially
          await runConnectivityTest();
          
          // Set up Signal K subscription after Signal K is ready
          setupSignalKSubscription();
          
          // Start periodic Venus connectivity tests
          plugin.connectivityInterval = setInterval(runConnectivityTest, 120000); // Check every 2 minutes
          
        } catch (err) {
          app.error('Error during bridge startup:', err);
          app.setPluginError(`Bridge startup failed: ${err.message}`);
        }
      }

      // Subscribe to Signal K updates for discovery and processing
      // We always subscribe to all device types for discovery, filtering happens later
      const subscriptions = [
        { path: 'electrical.batteries.*', period: config.interval },
        { path: 'tanks.*', period: config.interval },
        { path: 'environment.*', period: config.interval },
        { path: 'electrical.switches.*', period: config.interval }
      ];

      // Function to set up Signal K subscription
      function setupSignalKSubscription() {
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
              return;
            }
            
            // Filter paths early - only process paths we care about
            const deviceType = identifyDeviceType(data.path);
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
        } catch (err) {
          app.error('registerDeltaInputHandler method failed:', err);
        }
      } else {
        app.setPluginError('No compatible subscription method found');
        return;
      }
      
      // Function to process delta messages
      function processDelta(delta) {
        try {
          deltaCount++;
          lastDataTime = Date.now();
          
          if (delta.updates) {
            delta.updates.forEach(update => {
              // Check if update and update.values are valid
              if (!update || !Array.isArray(update.values)) {
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
                
                // Process this path value using the unified processing function
                await processPathValue(pathValue.path, pathValue.value, config);
              } catch (err) {
                // Only log unexpected errors, suppress common connection errors
                if (!err.message || (!err.message.includes('ENOTFOUND') && !err.message.includes('ECONNREFUSED'))) {
                  const pathInfo = pathValue?.path || 'unknown path';
                  app.error(`Unexpected error processing ${pathInfo}: ${err.message}`);
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
            // Check if any devices are enabled
            const hasEnabledDevices = ['batteries', 'tanks', 'environment', 'switches'].some(deviceType => {
              if (config[deviceType]) {
                return Object.values(config[deviceType]).some(enabled => enabled === true);
              }
              return false;
            });
            
            if (!hasEnabledDevices) {
              const deviceCountText = generateDeviceCountText();
              if (deviceCountText.includes('0 devices')) {
                app.setPluginStatus('Discovering Signal K devices');
              } else {
                app.setPluginStatus(`Device Discovery: Found ${deviceCountText} - configure in settings`);
              }
            } else if (venusReachable === false) {
              const deviceCountText = generateDeviceCountText();
              app.setPluginStatus(`Discovery: ${deviceCountText} found - Venus OS not connected at ${config.venusHost}`);
            } else {
              app.setPluginStatus(`Waiting for Signal K data (${config.venusHost})`);
            }
          }
        }, 2000);
      }
      
      // Test Venus OS connectivity initially and periodically
      async function runConnectivityTest() {
        try {
          const wasReachable = venusReachable;
          const isReachable = await testVenusConnectivity();
          
          // If Venus just became reachable, process any queued paths after a delay
          if (!wasReachable && isReachable && pendingPaths.length > 0) {
            app.debug(`Venus OS became reachable, waiting 5 seconds before processing ${pendingPaths.length} queued paths`);
            setTimeout(() => {
              processPendingPaths();
            }, 5000);
          }
        } catch (err) {
          app.error('Connectivity test error:', err);
        }
      }
      
      // Process paths that were queued while Venus OS was not reachable
      async function processPendingPaths() {
        if (isProcessingQueue || pendingPaths.length === 0) {
          return;
        }
        
        isProcessingQueue = true;
        app.debug(`Processing ${pendingPaths.length} queued paths...`);
        
        const pathsToProcess = [...pendingPaths];
        pendingPaths.length = 0; // Clear the queue
        
        for (const queuedPath of pathsToProcess) {
          try {
            app.debug(`Processing queued path: ${queuedPath.path}`);
            await processPathValue(queuedPath.path, queuedPath.value, config);
          } catch (err) {
            app.error(`Error processing queued path ${queuedPath.path}:`, err);
          }
        }
        
        isProcessingQueue = false;
        app.debug(`Finished processing queued paths`);
      }
      
      // Extract path processing logic into a separate function
      async function processPathValue(path, value, config) {
        const deviceType = identifyDeviceType(path);
        if (!deviceType) {
          return;
        }
        
        // Always do discovery
        addDiscoveredPath(deviceType, path, value, config);
        
        // Debug logging for device creation flow
        app.debug(`Processing ${deviceType} path: ${path}, Venus reachable: ${venusReachable}, Enabled: ${isPathEnabled(deviceType, path, config)}`);
        
        // Only proceed with Venus OS operations if Venus is reachable and path is enabled
        if (venusReachable !== true) {
          // Venus OS not reachable, add to queue for later processing
          const existingIndex = pendingPaths.findIndex(p => p.path === path);
          if (existingIndex >= 0) {
            // Update existing queued path with new value
            pendingPaths[existingIndex].value = value;
          } else {
            // Add new path to queue
            pendingPaths.push({ path, value, timestamp: Date.now() });
          }
          app.debug(`Queued path for later processing: ${path} (queue size: ${pendingPaths.length})`);
          return;
        }
        
        // Check if this specific path is enabled
        if (!isPathEnabled(deviceType, path, config)) {
          app.debug(`Skipping ${path} - not enabled in configuration`);
          return; // Skip disabled paths
        }
        
        // Create Venus client for this device type if it doesn't exist yet or has failed
        if (!plugin.clients[deviceType] || plugin.clients[deviceType] === null) {
          app.setPluginStatus(`Creating Venus OS service for ${deviceTypeNames[deviceType]}`);
          app.debug(`Creating new Venus client for device type: ${deviceType}`);
          
          try {
            plugin.clients[deviceType] = VenusClientFactory(config, deviceType);
            activeClientTypes.add(deviceTypeNames[deviceType]);
            
            const deviceCountText = generateEnabledDeviceCountText(config);
            app.setPluginStatus(`Connected to Venus OS, injecting ${deviceCountText}`);
            app.debug(`Successfully created Venus client for ${deviceType}`);
            
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
            app.debug(`Failed to create Venus client for ${deviceType}: ${cleanMessage}`);
            
            // Mark this client as failed to prevent retries
            plugin.clients[deviceType] = null;
            
            // Only log the first connection error per device type to avoid spam
            if (!plugin.clients[`${deviceType}_error_logged`]) {
              app.error(`Cannot connect to Venus OS for ${deviceTypeNames[deviceType]}: ${cleanMessage}`);
              plugin.clients[`${deviceType}_error_logged`] = true;
            }
            return;
          }
        }
        
        // Update the Venus client with the new data (whether client is new or existing)
        if (plugin.clients[deviceType] && plugin.clients[deviceType] !== null) {
          app.debug(`Updating Venus client ${deviceType} with path: ${path}`);
          try {
            await plugin.clients[deviceType].handleSignalKUpdate(path, value);
          } catch (err) {
            // Only log detailed errors if it's not a connection issue
            if (err.message && (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED'))) {
              // Suppress frequent connection errors when Venus OS is not available
              // The main connection error is already logged during client creation
              
              // Mark client as failed
              plugin.clients[deviceType] = null;
              activeClientTypes.delete(deviceTypeNames[deviceType]);
              app.debug(`Marked Venus client ${deviceType} as failed due to connection error`);
            } else {
              app.error(`Error updating ${deviceType} client for ${path}: ${err.message}`);
            }
          }
        }
      }

      
      // Start the bridge with Signal K readiness check
      startBridge();
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
  function identifyDeviceType(path) {
    // Filter out Cerbo GX relays (venus-0, venus-1) to prevent feedback loops
    if (path.match(/electrical\.switches\.venus-[01]\./)) {
      return null;
    }
    
    if (settings.batteryRegex.test(path)) return 'batteries';
    if (settings.tankRegex.test(path)) return 'tanks';
    if (settings.temperatureRegex.test(path) || settings.humidityRegex.test(path)) return 'environment';
    if (settings.switchRegex.test(path) || settings.dimmerRegex.test(path)) return 'switches';
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

  // Helper function to generate device count text by type (all discovered devices)
  function generateDeviceCountText() {
    const deviceCounts = {
      batteries: discoveredPaths.batteries.size,
      tanks: discoveredPaths.tanks.size,
      environment: discoveredPaths.environment.size,
      switches: discoveredPaths.switches.size
    };
    
    const deviceCountParts = [];
    if (deviceCounts.batteries > 0) {
      deviceCountParts.push(`${deviceCounts.batteries} ${deviceCounts.batteries === 1 ? 'battery' : 'batteries'}`);
    }
    if (deviceCounts.tanks > 0) {
      deviceCountParts.push(`${deviceCounts.tanks} ${deviceCounts.tanks === 1 ? 'tank' : 'tanks'}`);
    }
    if (deviceCounts.environment > 0) {
      deviceCountParts.push(`${deviceCounts.environment} environment ${deviceCounts.environment === 1 ? 'sensor' : 'sensors'}`);
    }
    if (deviceCounts.switches > 0) {
      deviceCountParts.push(`${deviceCounts.switches} ${deviceCounts.switches === 1 ? 'switch' : 'switches'}`);
    }
    
    if (deviceCountParts.length > 0) {
      return deviceCountParts.join(', ');
    } else {
      const totalPaths = Object.values(discoveredPaths).reduce((sum, map) => sum + map.size, 0);
      return `${totalPaths} devices`;
    }
  }

  // Helper function to generate device count text for enabled devices only
  function generateEnabledDeviceCountText(config) {
    const enabledCounts = {
      batteries: 0,
      tanks: 0,
      environment: 0,
      switches: 0
    };
    
    // Count enabled devices by checking configuration
    Object.entries(discoveredPaths).forEach(([deviceType, pathMap]) => {
      if (config[deviceType]) {
        pathMap.forEach((pathInfo, devicePath) => {
          const safePathKey = devicePath.replace(/[^a-zA-Z0-9]/g, '_');
          if (config[deviceType][safePathKey] === true) {
            enabledCounts[deviceType]++;
          }
        });
      }
    });
    
    const deviceCountParts = [];
    if (enabledCounts.batteries > 0) {
      deviceCountParts.push(`${enabledCounts.batteries} ${enabledCounts.batteries === 1 ? 'battery' : 'batteries'}`);
    }
    if (enabledCounts.tanks > 0) {
      deviceCountParts.push(`${enabledCounts.tanks} ${enabledCounts.tanks === 1 ? 'tank' : 'tanks'}`);
    }
    if (enabledCounts.environment > 0) {
      deviceCountParts.push(`${enabledCounts.environment} environment ${enabledCounts.environment === 1 ? 'sensor' : 'sensors'}`);
    }
    if (enabledCounts.switches > 0) {
      deviceCountParts.push(`${enabledCounts.switches} ${enabledCounts.switches === 1 ? 'switch' : 'switches'}`);
    }
    
    if (deviceCountParts.length > 0) {
      return deviceCountParts.join(', ');
    } else {
      return '0 devices';
    }
  }

  // Helper function to check if any paths have been discovered
  function hasDiscoveredPaths() {
    return Object.values(discoveredPaths).some(pathMap => pathMap.size > 0);
  }

  // Function to add a discovered path to tracking
  function addDiscoveredPath(deviceType, path, value, config) {
    try {
      const pathMap = discoveredPaths[deviceType];
      if (!pathMap) return;

      // Extract the device/sensor path (one level up from the property)
      const devicePath = getDevicePath(deviceType, path);
      if (!devicePath) return;

      const isNewDevice = !pathMap.has(devicePath);
      
      if (isNewDevice) {
        // Generate a human-readable display name
        let displayName = generateDisplayName(deviceType, devicePath);
        
        pathMap.set(devicePath, {
          displayName: displayName,
          firstSeen: new Date().toISOString(),
          lastValue: value,
          sampleValue: value,
          properties: new Set([path]) // Track which properties we've seen
        });

        // Trigger schema update if enough time has passed
        const now = Date.now();
        if (now - lastSchemaUpdate > 2000) { // Throttle updates to every 2 seconds
          lastSchemaUpdate = now;
          
          // Notify Signal K that the schema has changed (if supported)
          if (app.handleMessage && typeof app.handleMessage === 'function') {
            try {
              app.handleMessage(plugin.id, {
                type: 'schema-update',
                timestamp: new Date().toISOString()
              });
            } catch (err) {
              // Schema update notification not supported - ignore silently
            }
          }
        }
        
        app.debug(`Discovered new ${deviceType} device: ${displayName} (${devicePath})`);
      } else {
        // Update last seen value and add this property to the set
        const deviceInfo = pathMap.get(devicePath);
        deviceInfo.lastValue = value;
        deviceInfo.properties.add(path);
      }
      
      // Update status with discovered paths count by device type
      const deviceCountText = generateDeviceCountText();
      
      const statusMsg = plugin.venusConnected ? 
        `Connected to Venus OS, injecting ${generateEnabledDeviceCountText(config)}` :
        `Device Discovery: Found ${deviceCountText} (Venus OS: ${config.venusHost})`; 
      app.setPluginStatus(statusMsg);
      
    } catch (err) {
      app.error(`Error in addDiscoveredPath: ${err.message}`);
    }
  }

  // Function to extract device path from full property path
  function getDevicePath(deviceType, fullPath) {
    switch (deviceType) {
      case 'batteries':
        // electrical.batteries.0.voltage -> electrical.batteries.0
        const batteryMatch = fullPath.match(/^(electrical\.batteries\.[^.]+)/);
        return batteryMatch ? batteryMatch[1] : null;
        
      case 'tanks':
        // tanks.blackWater.0.currentLevel -> tanks.blackWater.0
        const tankMatch = fullPath.match(/^(tanks\.[^.]+\.[^.]+)/);
        return tankMatch ? tankMatch[1] : null;
        
      case 'environment':
        // environment.water.temperature -> environment.water.temperature (keep specific for single properties)
        // propulsion.main.temperature -> propulsion.main.temperature
        return fullPath;
        
      case 'switches':
        // electrical.switches.nav.state -> electrical.switches.nav
        const switchMatch = fullPath.match(/^(electrical\.switches\.[^.]+)/);
        return switchMatch ? switchMatch[1] : null;
    }
    
    return null;
  }

  // Function to generate human-readable display names
  function generateDisplayName(deviceType, devicePath) {
    switch (deviceType) {
      case 'batteries':
        // electrical.batteries.0 -> Battery (if only one) or Battery 1, Battery 2 (if multiple)
        const batteryMatch = devicePath.match(/electrical\.batteries\.(\d+|[^.]+)/);
        if (batteryMatch) {
          const batteryId = batteryMatch[1];
          // Count total batteries to decide if we need numbers
          const totalBatteries = discoveredPaths.batteries ? discoveredPaths.batteries.size : 0;
          const isGenericId = ['0', 'main', 'primary', 'default'].includes(batteryId.toLowerCase());
          
          if (totalBatteries <= 1 && isGenericId) {
            return 'Battery';
          }
          
          // Convert numeric IDs to start from 1 instead of 0
          let displayId = batteryId;
          if (/^\d+$/.test(batteryId)) {
            displayId = (parseInt(batteryId) + 1).toString();
          }
          return `Battery ${displayId}`;
        }
        break;
        
      case 'tanks':
        // tanks.freshWater.starboard -> Freshwater starboard (if specific name)
        const tankMatch = devicePath.match(/tanks\.([^.]+)\.([^.]+)/);
        if (tankMatch) {
          let tankType = tankMatch[1];
          const tankId = tankMatch[2]; // Can be any alphanumeric string per Signal K spec
          
          // Remove camel case and capitalize first letter
          tankType = tankType.replace(/([A-Z])/g, ' $1').trim();
          tankType = tankType.charAt(0).toUpperCase() + tankType.slice(1).toLowerCase();
          
          // Remove spaces for consistency (Fresh Water -> Freshwater)
          tankType = tankType.replace(/\s+/g, '');
          
          // Check if we have multiple tanks of this type
          const tanksOfThisType = Array.from(discoveredPaths.tanks?.keys() || [])
            .filter(path => path.includes(`tanks.${tankMatch[1]}.`)).length;
          
          // Use generic ID detection instead of assuming only '0' is generic
          const isGenericId = ['0', 'main', 'primary', 'default'].includes(tankId.toLowerCase());
          
          // If single tank with generic ID, omit the ID
          if (tanksOfThisType <= 1 && isGenericId) {
            return tankType;
          } else {
            // Multiple tanks or specific ID - include the ID
            // Convert numeric IDs to start from 1 instead of 0
            let displayId = tankId;
            if (/^\d+$/.test(tankId)) {
              displayId = (parseInt(tankId) + 1).toString();
            }
            return `${tankType} ${displayId}`;
          }
        }
        break;
        
      case 'environment':
        // environment.water.temperature -> Water temperature
        // propulsion.main.temperature -> Main temperature
        if (devicePath.includes('temperature')) {
          const tempMatch = devicePath.match(/environment\.([^.]+)\.temperature|propulsion\.([^.]+)\.temperature/);
          if (tempMatch) {
            let sensor = tempMatch[1] || tempMatch[2];
            // Remove camel case and capitalize first letter
            sensor = sensor.replace(/([A-Z])/g, ' $1').trim();
            sensor = sensor.charAt(0).toUpperCase() + sensor.slice(1).toLowerCase();
            return `${sensor} temperature`;
          }
        } else if (devicePath.includes('humidity') || devicePath.includes('relativeHumidity')) {
          const humMatch = devicePath.match(/environment\.([^.]+)\.(humidity|relativeHumidity)/);
          if (humMatch) {
            let sensor = humMatch[1];
            // Remove camel case and capitalize first letter
            sensor = sensor.replace(/([A-Z])/g, ' $1').trim();
            sensor = sensor.charAt(0).toUpperCase() + sensor.slice(1).toLowerCase();
            return `${sensor} humidity`;
          }
        }
        break;
        
      case 'switches':
        // electrical.switches.nav -> Nav (if functional name)
        const switchMatch = devicePath.match(/electrical\.switches\.([^.]+)/);
        if (switchMatch) {
          let switchId = switchMatch[1];
          
          // If it's a functional name (not just a number), use it directly
          if (!/^\d+$/.test(switchId)) {
            // Remove camel case and capitalize first letter
            switchId = switchId.replace(/([A-Z])/g, ' $1').trim();
            return switchId.charAt(0).toUpperCase() + switchId.slice(1).toLowerCase();
          } else {
            // It's a numeric ID - convert to start from 1 instead of 0
            const displayId = (parseInt(switchId) + 1).toString();
            return `Switch ${displayId}`;
          }
        }
        break;
    }
    
    // Fallback to path-based name with camel case removed
    const fallback = devicePath.split('.').pop() || devicePath;
    return fallback.replace(/([A-Z])/g, ' $1').trim()
      .charAt(0).toUpperCase() + fallback.slice(1).toLowerCase();
  }

  // Function to check if a path is enabled in configuration
  function isPathEnabled(deviceType, fullPath, config) {
    // Get the device path for checking individual configuration
    const devicePath = getDevicePath(deviceType, fullPath);
    if (!devicePath) return false; // Default to disabled if we can't parse the path

    // Check if this specific device is enabled in the new configuration structure
    if (config[deviceType]) {
      const safePathKey = devicePath.replace(/[^a-zA-Z0-9]/g, '_');
      return config[deviceType][safePathKey] === true;
    }

    // Default to disabled for newly discovered devices
    // Devices will be discovered and appear in the UI but won't be processed until explicitly enabled
    return false;
  }

  return plugin;
}