# Signal K to Victron Venus OS Bridge

Injects Signal K battery, tank, temperature, humidity, and switch data into Venus OS D-Bus, enabling full integration with the Cerbo GX, GX Touch, and VRM.

---

## ✅ Features

- Registers as full Victron D-Bus services
- Simulates battery, tank, temperature, humidity, switch, and dimmer data
- Bidirectional sync of switches and dimmers (Signal K ⇄ Cerbo GX)
- Sends `/Name` for tanks to Cerbo
- D-Bus compliant, works with VRM, GX Touch

---

## 🔧 Requirements

- Signal K server on Raspberry Pi or similar
- Victron Cerbo GX with Venus OS on same network
- SSH + D-Bus over TCP access on Cerbo

---

## 📦 Installation

1. **Enable SSH on Cerbo GX**

Via **touchscreen**:
> Settings → Remote Console → Enable SSH

Via **web interface**:
> http://venus.local → Settings → General → Enable SSH

Or plug in a USB stick with an `ssh` file and reboot.

```bash
ssh root@venus.local
```

2. **Enable D-Bus over TCP**

```bash
ssh root@venus.local
/usr/sbin/dbus -y com.victronenergy.settings /Settings/Services/InsecureDbusOverTcp SetValue 1
netstat -tuln | grep :78
```

3. **Install the plugin**

(Future: Look for `signalk-to-venus` in the Signal K App Store.)

Or clone manually:
```bash
cd ~/.signalk/node_modules/
git clone https://github.com/YOUR_REPO/signalk-to-venus
cd signalk-to-venus
npm install
```

4. Restart Signal K, enable the plugin, and configure.

---

## ⚙️ Configuration

| Key                  | Description                                      | Default        |
|----------------------|--------------------------------------------------|----------------|
| `venusHost`          | Hostname or IP of Cerbo GX                      | `venus.local`  |
| `productName`        | Name in VRM / Venus OS                         | `SignalK Virtual BMV` |
| `interval`           | Polling rate for websocket updates             | `1000`         |

Regex-based auto-mapping is used:
- Voltage, current, SoC: `electrical.batteries.*`
- Tanks: `tanks.*.(currentLevel|name)`
- Temperature: `environment.*.temperature`, `propulsion.*.temperature`
- Humidity: `environment.*.humidity|relativeHumidity`
- Switches & dimmers: `electrical.switches.*`

---

## 📡 Output (on Venus OS D-Bus)

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

## 🔄 Bidirectional

Changes on the Cerbo (touchscreen or VRM) will be sent back via `PUT` to Signal K. Works for:
- Switch state
- Dimmer level

---

## 🧪 Testing

Check presence on D-Bus:
```bash
dbus-spy --host=venus.local --port=78
```
Or on Cerbo GX:
> Settings → Services → Battery Monitor / Tanks / Environment

---

## 📝 License

MIT © Christian Wegerhoff
