# Signal K to Victron Venus OS Bridge

This plugin for Signal K Server injects batteries, tanks, environment sensors, and switches as virtual devices and battery monitor into the Venus OS (D-Bus), enabling full integration with the Cerbo GX, GX Touch, and VRM.

## Requirements

- Signal K server running on a Raspberry Pi or similar device
- Victron Cerbo GX with Venus OS (on the same network)
- SSH access to the Cerbo GX (see step 1)
- D-Bus over TCP must be enabled (see step 2)


## Installation

**1. Enable SSH on the Cerbo GX**

→ For detailed instructions see https://www.victronenergy.com/live/ccgx:root_access#root_access

On the **touchscreen** or **Remote Console**: 
- Navigate to: **Settings → General**
- Set the Access Level to **User & Installer** (the password is ZZZ)
- In the New UI, select, drag down and hold down the entire list of **Access & Security** menu entries for five seconds, until you see the access level change to **Superuser** and you see **Root password** and **Enable SSH on LAN**
- Enter a **Root password**, which will be the SSH password for `ssh root@venus.local`
- Enable the option **Enable SSH on LAN**

Test with:

```bash
ssh root@venus.local
```


**2. Enable D-Bus over TCP on the Cerbo GX**

This step allows external devices (like your Raspberry Pi) to access the Victron D-Bus remotely via TCP on port 78. It is required so the plugin can inject virtual devices over the network.

```bash
ssh root@venus.local
dbus -y com.victronenergy.settings /Settings/Services/InsecureDbusOverTcp SetValue 1
```

Reboot the Cerbo GX **Settings → General → Reboot** and test with:

```bash
ssh root@venus.local
netstat -tuln | grep :78
```

The expected result is a line showing that the Cerbo GX is listening on TCP port 78:
```
tcp        0      0 0.0.0.0:78              0.0.0.0:*               LISTEN  
```

**X. Manually Update Victron Venus Plugin to Avoid Feedback Loops**

The upcoming version of **Victron Venus Plugin** (`signalk-venus-plugin`) will ignore virtual devices injected by this plugin, avoiding reading virtual devices back to Signal K. If the latest published version of **signalk-venus-plugin** is still **v1.43.1 (2025-02-04)**, the fix hasn’t been released yet. In this case, apply the patch manually:

```bash
cd ~/.signalk/node_modules/signalk-venus-plugin
curl -O https://raw.githubusercontent.com/sbender9/signalk-venus-plugin/master/dbus-listener.js
curl -O https://raw.githubusercontent.com/sbender9/signalk-venus-plugin/31f52684afcf4d60a67850c8402806ba5573137b/index.js
```

**3. Install the plugin**

Look for `signalk-to-venus` in the Signal K App Store and install it directly.

To install manually:
```bash
cd ~/.signalk/node_modules/
git clone https://github.com/Krillle/signalk-to-venus.git
cd signalk-to-venus
npm install
```

**4. Restart Signal K server**

The plugin is enabled by default and should work right away with default settings.

If you see in the Signal K dashboard **signalk-to-venus** getting connection errors like **"Venus OS not reachable at venus.local"**, this means:
- Your Cerbo GX is not reachable at **venus.local**. Set the correct host or IP in the plugin settings.
- The D-Bus over TCP is not enabled on the Cerbo GX. See step 1 and 2.
- You don't have a Venus OS device on your network.


## Configuration

The plugin features a dynamic configuration interface that automatically discovers all compatible devices on your boat and allows you to selectively enable them.

### Basic Settings

| Setting              | Description                                      | Default                   |
|----------------------|--------------------------------------------------|---------------------------|
| `venusHost`          | Hostname or IP address of your Cerbo GX         | `venus.local`             |
| `interval`           | Data update interval in milliseconds            | `1000`                    |
| `batteryCapacity`    | Total battery capacity in Amp-hours             | `800`                     |

**Battery Capacity Setting**: Used for calculating time-to-charge when the battery is charging. If your Signal K system provides `electrical.batteries.X.capacity.nominal`, that value will be used instead. The configured capacity serves as a fallback for charge time calculations.

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

**All devices are disabled by default** - you must explicitly enable in the plugin settings the ones you want to send to Venus OS. This gives you complete control over what data appears in your VRM dashboard. (Display is limited by the maximum numbers of devices, the VRM/Cerbo UI is able to display.)

### Supported Signal K Paths

The plugin automatically detects and supports:

- **Batteries**: `electrical.batteries.*` (voltage, current, SoC, consumed Ah, time remaining, temperature)
- **Tanks**: `tanks.*` (current level, capacity, name)  
- **Temperature**: `environment.*.temperature`, `propulsion.*.temperature`
- **Humidity**: `environment.*.humidity` or `environment.*.relativeHumidity`
- **Switches/Dimmers**: `electrical.switches.*` (state, dimming level)

**Note**: The plugin automatically excludes devices directly connected to the Cerbo GX and its internal relay switches to prevent feedback loops.

## Output (Venus OS D-Bus Paths)

**Batteries (Battery Monitor):**
```
/Dc/0/Voltage              # Battery voltage (Volts)
/Dc/0/Current              # Battery current (Amps, + charging, - discharging)  
/Dc/0/Power                # Battery power (Watts)
/Soc                       # State of charge (0-100%)
/ConsumedAmphours          # Consumed amp-hours
/TimeToGo                  # Time remaining (seconds)
/Dc/0/Temperature          # Battery temperature (°C)
/Capacity                  # Battery capacity (Ah)
/Relay/0/State             # Battery relay state
/State                     # Battery state (0=Offline, 1=Online, 2=Error, 3=Unavailable)
/ErrorCode                 # Error code
/Connected                 # Connection status
/DeviceType                # Device type (512 = BMV)

# Battery Monitor System Properties
/System/HasBatteryMonitor  # Has battery monitor flag
/System/BatteryService     # Battery service active
/System/NrOfBatteries      # Number of batteries
/System/MinCellVoltage     # Minimum cell voltage
/System/MaxCellVoltage     # Maximum cell voltage

# Battery Monitor Alarms
/Alarms/LowVoltage         # Low voltage alarm
/Alarms/HighVoltage        # High voltage alarm
/Alarms/LowSoc             # Low SOC alarm
/Alarms/HighCurrent        # High current alarm
/Alarms/HighTemperature    # High temperature alarm
/Alarms/LowTemperature     # Low temperature alarm

# Battery Monitor History & Info
/History/DischargedEnergy  # Discharged energy
/History/ChargedEnergy     # Charged energy
/History/TotalAhDrawn      # Total Ah drawn
/History/MinimumVoltage    # Historical minimum voltage
/History/MaximumVoltage    # Historical maximum voltage
/Info/BatteryLowVoltage    # Battery low voltage info
/Info/MaxChargeCurrent     # Max charge current
/Info/MaxDischargeCurrent  # Max discharge current
/Info/MaxChargeVoltage     # Max charge voltage

# Battery Monitor Control
/Balancer                  # Balancer active
/Io/AllowToCharge          # Allow to charge
/Io/AllowToDischarge       # Allow to discharge
/Io/ExternalRelay          # External relay
```

**Tanks:**
```
/Level                     # Tank level (0-100%)
/Capacity                  # Tank capacity (liters/gallons)
/Remaining                 # Remaining volume (liters/gallons)
/FluidType                 # Fluid type (0=Fuel, 1=Fresh Water, 2=Waste Water, etc.)
/Status                    # Tank status
/CustomName                # Tank name for VRM display
/Volume                    # Tank volume (liters/gallons)
/RawUnit                   # Raw sensor unit (e.g., 'V' for voltage)
/RawValue                  # Raw sensor value
```

**Environment:**
```
/Temperature               # Temperature (°C)
/Humidity                  # Humidity (0-100%)
/Status                    # Sensor status
```

**Switches & Dimmers:**
```
/State                     # Switch state (0=Off, 1=On)
/Position                  # Switch position
/DimmingLevel              # Dimming level (0-100%)
```

## Bidirectional Operation

**Signal K → Venus OS**: All enabled devices send their data to Venus OS for display in VRM and on the Cerbo GX touch screen.

**Venus OS → Signal K**: Switch and dimmer changes made on the Cerbo GX or in VRM are automatically sent back to Signal K, keeping both systems synchronized.

**Supported bidirectional paths:**
- `electrical.switches.<id>.state` ⇄ Cerbo switch state
- `electrical.switches.<id>.dimmingLevel` ⇄ Cerbo dimmer level

## Loop Prevention & Safety

- **Venus OS Source Filtering**: The plugin excludes data originating from Venus OS devices (`venus.com.victronenergy.*` sources) at both data processing and device discovery levels
- **Virtual Device Marking**: All created D-Bus services are marked with `ProcessName: 'signalk-virtual-device'` for identification
- **Connection Validation**: Tests Venus OS connectivity before attempting to send data
- **Error Recovery**: Automatic retry logic with exponential backoff for connection failures
- **Clean Disconnection**: Proper D-Bus service cleanup when the plugin stops

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

**Service registered but devices don't appear (Advanced Debugging)**:

If you see `com.victronenergy.virtual.tanks` in the D-Bus service list but no devices appear:

1. **Check if devices are enabled in plugin settings** (most common issue):
   - All devices are disabled by default
   - Go to Signal K Server → Plugin Config → signalk-to-venus
   - Enable at least one device in each category you want to use

2. **Verify D-Bus interface export**:
   ```bash
   # On the Cerbo GX - check if the service has proper interfaces
   dbus -y com.victronenergy.virtual.tanks / GetValue
   # Should return device data, not an error
   ```

3. **Check device registration with Venus OS**:
   ```bash
   # On the Cerbo GX - see if Venus OS recognizes the device
   dbus -y com.victronenergy.system /Devices GetValue
   # Look for virtual device entries
   ```

4. **Monitor Signal K data flow**:
   - Check Signal K Data Browser for actual tank data: `tanks.freshWater.0.currentLevel`
   - Plugin only exports devices when Signal K data is available
   - Check plugin status for "Waiting for Signal K data" message

5. **Check D-Bus property export**:
   ```bash
   # On the Cerbo GX - inspect the virtual service properties
   dbus -y com.victronenergy.virtual.tanks /Tank/0/Level GetValue
   # Should return tank level data
   ```

**Nothing shows up in Cerbo/VRM (Advanced Debugging)**:

1. **Check if devices are enabled in plugin settings** (most common issue):
   - All devices are disabled by default
   - Go to Signal K Server → Plugin Config → signalk-to-venus
   - Enable at least one device in each category you want to use

2. **Verify D-Bus service registration**:
   ```bash
   # On the Cerbo GX
   ssh root@venus.local
   dbus -y com.victronenergy.system /ServiceMapping GetValue
   # Look for com.victronenergy.virtual.* services
   ```

3. **Check if plugin is connecting**:
   - Check Signal K plugin status message
   - Should show "Connected to Venus OS at venus.local"
   - If stuck on "Connecting..." there's a D-Bus authentication issue

4. **Monitor D-Bus traffic**:
   ```bash
   # On the Cerbo GX
   dbus-monitor --system | grep victronenergy.virtual
   # Should show service registration attempts
   ```

5. **Check for Signal K data**:
   - Verify Signal K has actual data for enabled devices
   - Check Signal K Data Browser for paths like `electrical.batteries.*`
   - Plugin only creates devices when Signal K data is available

6. **Verify network connectivity**:
   ```bash
   # On Signal K server
   telnet venus.local 78
   # Should connect to D-Bus port
   ```

**Changes in VRM not reflected in Signal K**:
- Only switches and dimmers support bidirectional sync
- Check Signal K debug console for incoming updates
- Verify the device is properly mapped in both directions

MIT © Christian Wegerhoff


## Change Log

### v1.0.16 (2025/07/27 22:30)
- Enhanced Time to Go (TTG) calculation: Implemented intelligent battery time-to-go calculation with Signal K `electrical.batteries.X.capacity.timeRemaining` priority
- Implemented Time To Charge: Calculates time-to-full (100% SoC) during charging scenarios with positive current and sends to Venus as /TimeToGo. (Set your total battery capacity in Amp-hours in plugin settings.) 

### v1.0.15 (2025/07/27 16:15)
- Improved Signal K subscription method: Updated to use the proper `subscriptionmanager.subscribe()` API according to Signal K documentation, replacing previous incorrect subscription methods
- Added Venus OS source filtering: Implemented comprehensive feedback loop prevention that automatically detects and excludes data originating from Venus OS devices (`venus.com.victronenergy.*` sources) at both data processing and device discovery levels
- Enhanced MMSI-based vessel filtering: Plugin now correctly subscribes only to data from the vessel's own MMSI context, preventing interference from other boats
- Reduced debug logging: Streamlined log output to essential information while maintaining visibility into source filtering and connection status

### v1.0.14 (2025/07/25 13:00)
Sending real values on startup. (Before it has been default values for initialisation.)

### v1.0.13 (2025/07/22 17:30)
First working version

## Known Issues
- **Loop prevention from signalk-venus not working yet**  
If you're using the signalk-venus plugin, virtual devices from Venus OS will loop back into Signal K. This can cause duplicate data. An update to signalk-venus is in progress to resolve this. (See Installation, Step X)

- **Virtual devices missing after startup**  
There is a remaining race condition that has not yet been fully identified. Although the plugin waits 15 seconds to allow the Signal K data tree to populate and Venus OS to initialize, not all virtual devices are always recognized by Venus OS on startup. A manual toggle (disabling and re-enabling the plugin) resolves the issue and all devices appear as expected.

- **Switches in Venus OS beta**  
Switches are not tested yet (and probably not working), as Venus OS does not yet support switches