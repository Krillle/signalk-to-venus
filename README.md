# Signal K to Victron Venus OS Bridge

Injects Signal K battery, tank, temperature, humidity, and switch data into Venus OS D-Bus, enabling full integration with the Cerbo GX, GX Touch, and VRM.

## Features

- **Dynamic Device Discovery**: Automatically discovers all Signal K devices on your boat and presents them in an intuitive configuration UI
- **Selective Device Control**: Enable/disable individual devices - only send the data you want to Venus OS
- **Smart Device Naming**: Intelligent display names (e.g., "Freshwater", "Nav", "Main engine temperature")
- **Registers as Proper D-Bus Services**: Creates valid Victron D-Bus services for seamless VRM integration
- **Bidirectional Sync**: Switches and dimmers sync both ways (Signal K ⇄ Cerbo GX)
- **Loop Prevention**: Automatically excludes Cerbo GX internal relays to prevent feedback loops
- **Real-time Status Monitoring**: Live connection status and data flow indicators with heartbeat
- **Robust Error Handling**: Automatic connection retry, timeout handling, and meaningful error messages
- **Production Ready**: Optimized D-Bus connections, proper cleanup, and Venus OS compatibility testing


## Requirements

- Signal K server running on a Raspberry Pi or similar device
- Victron Cerbo GX with Venus OS (on the same network)
- SSH access to the Cerbo GX (see step 1)
- D-Bus over TCP must be enabled (see step 2)


## Installation

**1. Enable SSH on the Cerbo GX**

You can do this via:

- The **touchscreen**: Navigate to: **Settings → Remote Console → Enable SSH**

- The **web interface** at `http://venus.local` or the device IP: Go to **Settings → General → Enable SSH**

- Alternatively: Insert a USB stick with a file named `ssh` in the root directory and reboot the Cerbo.

Afterward, test with:

```bash
ssh root@venus.local
```

(Default user is `root`, no password needed by default.)


**2. Enable D-Bus over TCP on the Cerbo GX**

This step allows external devices (like your Raspberry Pi) to access the Victron D-Bus remotely via TCP on port 78. It is required so the plugin can simulate a BMV device over the network.

```bash
ssh root@venus.local
dbus -y com.victronenergy.settings /Settings/Services/InsecureDbusOverTcp SetValue 1
netstat -tuln | grep :78
```


**3. Install the plugin**

Look for `signalk-to-venus` in the Signal K App Store and install it directly.

To install manually:
```bash
cd ~/.signalk/node_modules/
git clone https://github.com/YOUR_USERNAME/signalk-to-venus
cd signalk-to-venus
npm install
```

**4. Restart Signal K server**

The plugin is enabled by default and should work right away with default settings.

**"Venus OS not reachable at venus.local"**

If you see **signalk-to-venus** getting connection errors, this means:
- Your Cerbo GX is not reachable at **venus.local**. Set the correct host or IP in the plugin settings.
- The D-Bus over TCP is not enabled on the Cerbo GX. See step 1 and 2
- You don't have a Venus OS device on your network


## Configuration

The plugin features a dynamic configuration interface that automatically discovers all compatible devices on your boat and allows you to selectively enable them.

### Basic Settings

| Setting              | Description                                      | Default                   |
|----------------------|--------------------------------------------------|---------------------------|
| `venusHost`          | Hostname or IP address of your Cerbo GX         | `venus.local`             |
| `productName`        | Product name shown in VRM and Venus OS          | `SignalK Virtual Device`  |
| `interval`           | Data update interval in milliseconds            | `1000`                    |

### Device Selection

After starting the plugin, it will automatically discover all compatible Signal K devices and group them by type:

```
> Batteries
☐ Battery (electrical.batteries.0)
☐ House bank (electrical.batteries.house)

> Tanks  
☐ Freshwater (tanks.freshWater.0)
☐ Blackwater (tanks.blackWater.0)
☐ Fuel 0 (tanks.fuel.0)
☐ Fuel 1 (tanks.fuel.1)

> Environment
☐ Water temperature (environment.water.temperature)
☐ Engine temperature (propulsion.main.temperature)
☐ Cabin humidity (environment.cabin.humidity)

> Switches & Dimmers
☐ Nav (electrical.switches.nav)
☐ Anchor (electrical.switches.anchor)
☐ Cabin lights (electrical.switches.cabinLights)
```

**All devices are disabled by default** - you must explicitly enable in the plugin settings the ones you want to send to Venus OS. This gives you complete control over what data appears in your VRM dashboard.

### Supported Signal K Paths

The plugin automatically detects and supports:

- **Batteries**: `electrical.batteries.*` (voltage, current, SoC, consumed Ah, time remaining, temperature)
- **Tanks**: `tanks.*` (current level, capacity, name)  
- **Temperature**: `environment.*.temperature`, `propulsion.*.temperature`
- **Humidity**: `environment.*.humidity` or `environment.*.relativeHumidity`
- **Switches/Dimmers**: `electrical.switches.*` (state, dimming level)

**Note**: The plugin automatically excludes Cerbo GX internal relay switches (`venus-0`, `venus-1`) to prevent feedback loops.


## Status Monitoring

The plugin provides comprehensive real-time status updates in the Signal K dashboard:

- **Starting**: `Starting Signal K to Venus OS bridge`
- **Discovery**: `Discovered 12 Signal K devices (Venus OS not connected)` during testing
- **No Selection**: `Select devices to be sent to Venus OS in settings` when no devices are enabled
- **Connecting**: `Connecting to Venus OS at venus.local for Batteries`
- **Connected**: `Connected to Venus OS at venus.local for [Batteries, Environment, Tanks]`
- **Active**: `Connected to Venus OS at venus.local for [Batteries, Tanks] ♥︎` with heartbeat when data flows
- **Waiting**: `Waiting for Signal K data (venus.local)` if no compatible data is received
- **Connection Issues**: `Venus OS not reachable: connection refused (check D-Bus TCP setting)`

The heartbeat indicator (♥︎/♡) shows that data is actively flowing to Venus OS. The status clearly shows which device types are connected and any configuration issues.


## How It Works

1. **Device Discovery**: The plugin subscribes to all relevant Signal K paths and automatically discovers available devices
2. **Dynamic Configuration**: Discovered devices appear in the plugin settings, grouped by type with intelligent display names
3. **Selective Bridging**: Only enabled devices are sent to Venus OS - you have full control
4. **D-Bus Integration**: Creates proper Victron D-Bus services that integrate seamlessly with VRM
5. **Bidirectional Sync**: Switch and dimmer changes in VRM/Cerbo are reflected back to Signal K
6. **Smart Naming**: Device names are automatically generated following Victron conventions

## Device Naming Logic

The plugin generates intelligent display names:

- **Single devices**: "Battery", "Freshwater" (numbers omitted)
- **Multiple devices**: "Battery 0", "Battery 1", "Fuel 0", "Fuel 1"  
- **Functional names**: "Nav", "Anchor" (device type omitted for switches with descriptive names)
- **Generic IDs**: "Switch 0", "Switch 1" (device type kept for numbered switches)
- **CamelCase conversion**: "freshWater" → "Freshwater", "navLights" → "Navlights"

## Output (Venus OS D-Bus Paths)

**Batteries:**
```
/Dc/0/Voltage          # Volts
/Dc/0/Current          # Amps (+ charging, - discharging)  
/Soc                   # State of charge (0-100%)
/ConsumedAmphours      # Consumed amp-hours
/TimeToGo              # Time remaining (seconds)
/Dc/0/Temperature      # Battery temperature (°C)
/Relay/0/State         # Battery relay state
```

**Tanks:**
```
/Tank/0/Level          # Tank level (0-100%)
/Tank/0/Name           # Tank name for VRM display
/Tank/0/Capacity       # Tank capacity (if available)
```

**Environment:**
```
/Environment/Temperature/Outside    # °C
/Environment/Temperature/MainCabin  # °C
/Environment/Humidity/Outside       # 0-100%
/Environment/Humidity/MainCabin     # 0-100%
```

**Switches & Dimmers:**
```
/Switches/<id>/State     # 0=Off, 1=On
/Switches/<id>/DimLevel  # 0-100% dimming level
```

## Bidirectional Operation

**Signal K → Venus OS**: All enabled devices send their data to Venus OS for display in VRM and on the Cerbo GX touch screen.

**Venus OS → Signal K**: Switch and dimmer changes made on the Cerbo GX or in VRM are automatically sent back to Signal K, keeping both systems synchronized.

**Supported bidirectional paths:**
- `electrical.switches.<id>.state` ⇄ Cerbo switch state
- `electrical.switches.<id>.dimmingLevel` ⇄ Cerbo dimmer level

## Loop Prevention & Safety

- **Cerbo Relay Exclusion**: Automatically excludes `venus-0` and `venus-1` relay switches to prevent feedback loops
- **Virtual Device Marking**: All created D-Bus services are marked with `ProcessName: 'signalk-virtual-device'` for identification
- **Connection Validation**: Tests Venus OS connectivity before attempting to send data
- **Error Recovery**: Automatic retry logic with exponential backoff for connection failures
- **Clean Disconnection**: Proper D-Bus service cleanup when the plugin stops

## Testing Without Venus OS

The plugin includes a testing mode for development and troubleshooting:

- When Venus OS is not available, the plugin continues to discover Signal K devices
- Status shows: `Discovered X Signal K devices (Venus OS not connected)`
- All device discovery and configuration features work normally
- Simply enable Venus OS connectivity when ready to bridge data

## Troubleshooting

**"Venus OS not reachable"**: 
- Check that your Cerbo GX is accessible at the configured hostname/IP
- Verify D-Bus over TCP is enabled (see installation step 2)
- Test connectivity: `telnet venus.local 78`

**"No Signal K data received"**:
- Verify your Signal K server is receiving data from your boat's sensors
- Check the Signal K data browser for expected paths
- Ensure your device paths match the supported patterns

**Devices not appearing in VRM**:
- Wait up to 5 minutes for VRM to discover new devices
- Check Venus OS device list: Settings → Device List
- Verify the plugin status shows active connections with heartbeat

**Changes in VRM not reflected in Signal K**:
- Only switches and dimmers support bidirectional sync
- Check Signal K debug console for incoming updates
- Verify the device is properly mapped in both directions

MIT © Christian Wegerhoff

## Recent Updates (v1.0.4)

- **Dynamic Device Discovery**: Automatic discovery and configuration of all Signal K devices
- **Selective Device Control**: Enable/disable individual devices instead of device types
- **Improved Naming**: Smart device names following Victron conventions
- **Enhanced UI**: Clean, collapsible configuration interface grouped by device type
- **Better Status Reporting**: Real-time connection status with heartbeat indicators
- **Fixed D-Bus Connectivity**: Resolved TCP connection issues with Venus OS
- **Loop Prevention**: Automatic exclusion of Cerbo GX internal relays
- **Testing Mode**: Full functionality when Venus OS is not connected
- **All devices disabled by default**: Explicit user control over data bridging