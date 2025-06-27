# Signal K to Victron Venus OS Bridge

Injects Signal K battery, tank, temperature, humidity, and switch data into Venus OS D-Bus, enabling full integration with the Cerbo GX, GX Touch, and VRM.

---

## Features

- Registers as full Victron D-Bus services
- Simulates battery monitors, tank level sensors, temperature sensors, humiditysensors, switches, and dimmers
- Bidirectional sync of switches and dimmers (Signal K ⇄ Cerbo GX)
- Sends `/Name` for tanks to Cerbo
- D-Bus compliant, works with VRM, GX Touch

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

Look for `signalk-to-venus`in the Signal K app store.  

To install manually, clone or copy the plugin folder into `~/.signalk/node_modules/signalk-to-venus` and install dependecies with `npm install` inside the plugin folder.

**4. Restart Signal K server**

The plug in is enabled by default and should work right away with default settings. 

**Error "Venus OS not reachable: Connection timeout to Venus OS at venus.local:78"**

If you find **signalk-virtual-bmv** getting a timeout connecting to Venus OS, your Cerbo GX is not reachable at **venus.local**. Open the **Plugin Config** section in the Signal K web UI and configure the connection settings.

---

## Configuration

| Key                  | Description                                      | Default                   |
|----------------------|--------------------------------------------------|---------------------------|
| `venusHost`          | Hostname or IP of Cerbo GX                       | `venus.local`             |
| `productName`        | Name shown in VRM / Venus OS                     | `SignalK Virtual Devices` |
| `interval`           | Update interval in milliseconds                  | `1000`                    |

Regex-based auto-mapping is used:
- Voltage, current, SoC: `electrical.batteries.*`
- Tanks: `tanks.*.(currentLevel|name)`
- Temperature: `environment.*.temperature`, `propulsion.*.temperature`
- Humidity: `environment.*.humidity|relativeHumidity`
- Switches & dimmers: `electrical.switches.*`

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
