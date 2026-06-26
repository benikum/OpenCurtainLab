# OpenCurtainLab

**OpenCurtainLab is an open-source shutter tester for analog camera shutters.**

It combines an ESP32, five optical sensor channels, a flash-sync input, an OLED display, and a standalone browser WebUI. The device captures raw shutter timing locally and the WebUI turns that data into practical information: exposure accuracy, shutter spread, curtain travel behavior, flash-sync timing and charts.

OpenCurtainLab is designed for camera repair, shutter testing, calibration work, and repeatable documentation of analog camera bodies without relying on a cloud service or proprietary backend.

<p align="center">
  <img src="docs/images/readme-hero.jpg" alt="OpenCurtainLab device" width="48%">
  <img src="docs/images/webui-overview.jpg" alt="OpenCurtainLab WebUI" width="48%">
</p>

## Features

### Hardware-focused measurement

- Five optical sensor channels for focal-plane shutter timing
- Measurement modes for horizontal and vertical travel focal-plane shutters and leaf shutters
- Flash-sync input for checking X-sync behavior
- OLED display for device status, WiFi information, measurement state, and quick results
- Three-button local control for operation without a computer during basic use
- Battery-voltage monitoring

### Standalone WebUI

- Runs in a normal browser after being downloaded from the device
- Connects to the ESP32 over the local network
- Shows exposure time, deviation from target speed, shutter spread, and measurement hints
- Provides timeline, curtain-speed, and flash-sync visualizations
- Stores projects and measurement history in the browser
- Supports import, export and CSV export

### Open local API

- Local HTTP API for status, configuration, diagnostics, and raw measurement data
- JSON responses for easy integration with scripts, tools, or alternative UIs
- Sensor diagnostics endpoint for setup and troubleshooting

## Project structure

```text
OpenCurtainLab.ino          Main Arduino sketch and application loop
src/                        Firmware modules, configuration, measurement logic, API, WiFi, OLED
web/                        WebUI source files
web/compiled/               Generated standalone WebUI release file
tools/                      Release and development helper scripts
docs/BUILD_GUIDE.md         Step-by-step hardware and firmware build guide
docs/API.md                 Firmware API documentation
LICENSE                     Project license
```

## Build the project

OpenCurtainLab consists of a ESP32-based electronics assembly, a five-sensor shutter gate, flash-sync wiring, battery monitoring, and mechanical parts such as a sensor holder or enclosure.

The complete build process is documented in the build guide:

**[Open the step-by-step build guide](docs/BUILD_GUIDE.md)**

The build guide covers:

- required parts and example purchase links
- PCB or perfboard layout planning
- sensor board wiring
- OLED, buttons, flash-sync input, and battery divider
- 3D-printed parts and enclosure placeholders
- firmware pin configuration
- first electrical checks and troubleshooting

<p align="center">
  <img src="docs/images/schematic-overview.jpg" alt="OpenCurtainLab electronics overview" width="70%">
</p>

## Basic usage

### 1. Power the device

Flash the firmware, connect the electronics, and power the ESP32. The OLED shows the current device state.

### 2. Connect WiFi

On first start, the device opens a setup access point named `OpenCurtainLab`.

Connect to that access point and open the captive portal.

Select your WiFi network, enter the password, and save the settings.

### 3. Download the WebUI

Download the standalone WebUI on your browser through:

```text
http://opencurtainlab.local
```

The WebUI can then be opened locally in the browser and connects to the device on your network.

### 4. Make the first measurement

Place the sensor assembly where the film gate would be, point a stable light source through the shutter, select the measurement mode and target speed, then fire the shutter.

### Local button controls

The device has three active-low buttons: **Up**, **Down**, and **Select**. In normal ready mode, the firmware automatically listens for a shutter event; the buttons are mainly used to change the target speed, switch the measurement direction, open the local menu, and review results.

| State | Button | Action |
|---|---|---|
| Ready | Up | Select the next faster target speed. |
| Ready | Down | Select the next slower target speed. |
| Ready | Hold Up | Cycle the measurement direction: horizontal, vertical, or central shutter. |
| Ready | Select | Open the OLED settings menu. |
| Menu | Up / Down | Move through the menu entries. |
| Menu | Select | Change the selected menu value. |
| Menu | Hold Select | Save the menu settings and return to ready mode. |
| Results | Up / Down | Switch between result pages or leave the result view. |
| Results | Select | Close the result view and return to ready mode. |

The OLED menu provides quick access to sensor sensitivity, target time series, result display behavior, OLED sleep timeout, and network reset.
The WebUI displays the captured result, including exposure timing, shutter spread, chart views, measurement hints, and flash-sync information.

<p align="center">
  <img src="docs/images/first-start.jpg" alt="OpenCurtainLab first start" width="70%">
</p>

## API documentation

The firmware exposes a local HTTP API for status, configuration, live sensor diagnostics, and measurement data.

**[Open the API documentation](docs/API.md)**

Typical endpoints include:

```text
GET  /version
GET  /status
GET  /config
POST /config
GET  /data
GET  /sensors
GET  /wifi/status
POST /wifi
```

## AI usage transparency

AI tools were used during development as an assistant for code review, refactoring, documentation drafting, and implementation exploration. The project design, hardware decisions, test results, firmware behavior, API behavior, and published releases remain the responsibility of the maintainer.

## License

OpenCurtainLab is released under the MIT License. See [LICENSE](LICENSE).
