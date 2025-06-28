# Signal K to Victron Venus OS Bridge

Injects Signal K battery, tank, temperature, humidity, and switch data into Venus OS D-Bus, enabling full integration with the Cerbo GX, GX Touch, and VRM.

---

## Features

- Registers as full Victron D-Bus services
- Simulates battery monitors, tank level sensors, temperature sensors, humidity sensors, switches, and dimmers
- Bidirectional sync of switches and dimmers (Signal K ⇄ Cerbo GX)
- Sends `/Name` for tanks to Cerbo
- D-Bus compliant, works with VRM, GX Touch
- Real-time status monitoring and error reporting
- Automatic connection retry and timeout handling
- Uses Signal K's internal APIs for optimal performance

---

## Requirements

- Signal K server running on a Raspberry Pi or similar device
- Victron Cerbo GX with Venus OS (on the same network)
- SSH access to the Cerbo GX (see step 1)
- D-Bus over TCP must be enabled (see step 2)

---

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

---

## Configuration

| Key                  | Description                                      | Default                   |
|----------------------|--------------------------------------------------|---------------------------|
| `venusHost`          | Hostname or IP of Cerbo GX                       | `venus.local`             |
| `productName`        | Name shown in VRM / Venus OS                     | `SignalK Virtual Device`     |
| `interval`           | Update interval in milliseconds                  | `1000`                    |

Regex-based auto-mapping is used:
- Voltage, current, SoC: `electrical.batteries.*`
- Tanks: `tanks.*.(currentLevel|name)`
- Temperature: `environment.*.temperature`, `propulsion.*.temperature`
- Humidity: `environment.*.humidity|relativeHumidity`
- Switches & dimmers: `electrical.switches.*` (excludes `venus-0` and `venus-1` internal relays)

---

## Status Monitoring

The plugin provides real-time status updates in the Signal K web interface:

- **Starting**: `Starting Signal K to Venus OS bridge`
- **Connecting**: `Connecting to Venus OS at venus.local for Batteries...`
- **Connected**: `Connected to Venus OS at venus.local for [Batteries, Environment, Tanks, Switches]`
- **Activity**: Shows alternating heartbeat ♥︎ when data is flowing to Venus OS
- **Waiting**: `Waiting for Signal K data (venus.local)` if no compatible paths are found
- **Error**: `Venus OS not reachable: [error details]` if connection fails
- **No devices**: `No device types enabled - check plugin configuration` if all types are disabled

The status shows which device types are actively connected and displays a heartbeat indicator when data is successfully being sent to Venus OS.

---

## Output (on Venus OS D-Bus)

Battery:
```
/Dc/0/Voltage
/Dc/0/Current
/Soc
/TimeToGo
/Dc/1/Voltage
```

Tanks:
```
/Tank/<n>/Level
/Tank/<n>/Name
```

Temperature:
```
/Environment/Temperature/Outside
/Environment/Temperature/MainCabin
...
```

Humidity:
```
/Environment/Humidity/Outside
/Environment/Humidity/MainCabin
...
```

Switches & Dimmers:
```
/Switches/<id>/State
/Switches/<id>/DimLevel
```

---

## Bidirectional

Changes on the Cerbo (touchscreen or VRM) will be sent back to Signal K. Works for:
- Switch state
- Dimmer level

**Note**: The plugin automatically filters out Cerbo GX internal relays (`venus-0` and `venus-1`) to prevent feedback loops. These relays are managed directly by Venus OS and should not be bridged back through Signal K.

---

## Testing

Check presence on D-Bus:
```bash
dbus-spy --host=venus.local --port=78
```
Or on Cerbo GX:
> Settings → Services → Battery Monitor / Tanks / Environment

---

MIT © Christian Wegerhoff
