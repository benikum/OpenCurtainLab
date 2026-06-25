# OpenCurtainLab

OpenCurtainLab is an open-source ESP32-based shutter tester for focal-plane and leaf shutters. It uses five light sensors and a flash-sync input to measure shutter opening and closing times, then exposes the raw data through a local HTTP API and a standalone browser WebUI.

![OpenCurtainLab device placeholder](docs/images/readme-hero.jpg)

## What it does

OpenCurtainLab helps compare the real exposure behavior of a camera shutter against nominal shutter speeds. It is intended for repair, testing, learning, and repeatable project documentation.

Key features:

- Five phototransistor channels for shutter travel timing
- Horizontal, vertical, and central shutter measurement modes
- Flash-sync contact timing
- OLED status display with local buttons for standalone use
- WiFi setup portal and local HTTP API
- Standalone WebUI for projects, measurement history, charts, import, and export
- Sensor diagnostics through the WebUI and `/sensors` API endpoint
- Configurable target-speed series and sensor sensitivity
- Optional battery voltage monitor
- No cloud service or account required during normal local operation

![WebUI placeholder](docs/images/webui-overview.jpg)

## Project structure

```text
OpenCurtainLab.ino              Main Arduino sketch
src/                            Firmware modules and configuration
web/                            Source files for the standalone WebUI
web/compiled/                   Generated compiled WebUI release files
tools/                          Release/build helper scripts
docs/BUILD_GUIDE.md             Step-by-step build guide
docs/API.md                     Firmware HTTP API documentation
```

Generated files should not be edited manually:

```text
src/SetupPortalHtml.h
web/compiled/compiled-v*.html
```

Use `tools/release.py` to rebuild them.

## Hardware summary

The default firmware configuration expects:

| Function | Default pin |
|---|---:|
| Sensor 0 | GPIO36 |
| Sensor 1 | GPIO39 |
| Sensor 2 | GPIO34 |
| Sensor 3 | GPIO35 |
| Sensor 4 | GPIO32 |
| Battery voltage ADC | GPIO33 |
| Flash sync | GPIO14 |
| Button Up | GPIO25 |
| Button Down | GPIO26 |
| Button Listen | GPIO27 |
| I2C SDA | GPIO21 |
| I2C SCL | GPIO22 |

The phototransistor channels are expected to read high ADC values in darkness and lower values when light reaches the sensor. The firmware uses absolute ADC thresholds with hysteresis.

Default geometry:

| Setting | Value |
|---|---:|
| Sensor count | 5 |
| Horizontal sensor spacing | 13.17 mm |
| Vertical sensor spacing | 7.67 mm |

See the full [build guide](docs/BUILD_GUIDE.md) for parts, wiring, PCB layouts, 3D-prints, and firmware configuration.

## Software requirements

Firmware build:

- Arduino IDE or Arduino CLI
- ESP32 Arduino core
- ArduinoJson
- Adafruit GFX Library
- Adafruit SSD1306
- Wire, included with the Arduino/ESP32 core

WebUI build and release helper:

- Python 3.10 or newer
- `minify-html` Python package
- Node.js is optional, but useful for JavaScript syntax checks

Install the Python minifier:

```bash
python3 -m pip install minify-html
```

## First start

1. Build and flash the firmware to the ESP32
2. Power the device
3. If no WiFi credentials are stored, the device starts the setup access point `OpenCurtainLab`
4. Connect a phone or computer to that access point
5. Open the captive portal or go to:

```text
http://192.168.4.1
```

6. Select your WiFi network and save the credentials
7. After the ESP32 joins your network, download the WebUI at:

```text
http://opencurtainlab.local
```

If mDNS is not available on your system, use the IP address shown on the OLED.

![First start placeholder](docs/images/first-start.jpg)

## Basic measurement workflow

1. Place the sensor assembly where the film gate would be
2. Point a stable light source through the shutter toward the sensors
3. Select the measurement mode and target shutter speed on the device or in the WebUI
4. Press Listen or start listening through the WebUI
5. Fire the camera shutter
6. Open the WebUI to review exposure values, spread, timing charts, flash-sync timing, and project history

The firmware reports raw timestamps. The WebUI performs exposure, deviation, travel, and chart calculations.

## API documentation

See [docs/API.md](docs/API.md) for all current endpoints, response examples, status keys, measurement hints, and WiFi setup responses.

## Development notes

OpenCurtainLab is a hardware-tested project developed and maintained by the author. AI tools were used during development as an assistant for review, refactoring, documentation, and implementation exploration. Hardware behavior, firmware changes, API behavior, and measurement results remain the maintainer's responsibility.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).
