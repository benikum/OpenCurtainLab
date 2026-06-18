# OpenCurtainLab Firmware

OpenCurtainLab is an ESP32-based shutter tester for cameras. It uses five phototransistors plus a flash-sync input to capture shutter travel and exposure timing. The firmware provides a local OLED interface, a setup access point for WiFi provisioning, and a JSON API for an external WebUI.

## Hardware overview

The firmware is designed for one fixed sensor layout:

- ESP32 development board
- 5 phototransistors for shutter measurement
- 1 flash-sync input
- SSD1306 OLED display, 128 x 64 px
- 3 buttons: listen/menu, up, down
- LED/lamp output for the sensor light source
- Lamp-jack sense input that prevents enabling the lamp output when the lamp connector is shorted or plugged into the flash contact

Pin assignments, geometry, timing limits, and firmware URLs are defined in `src/Config.h`.

## User flow

The device has four user-visible states:

- `READY`: sensors are armed and the device waits for a shutter event
- `MEASURING`: a shutter event is being captured with high polling priority
- `RESULTS`: the latest measurement is shown on the OLED and exposed through the API
- `MENU`: local OLED settings menu

During `MEASURING`, the firmware intentionally avoids web, display, and button work so sensor polling stays as fast and stable as possible.

## Local controls

| Button | READY | RESULTS | MENU |
|---|---|---|---|
| Listen short | Open menu | Return to ready | Change selected setting |
| Listen long | - | - | Save and leave menu |
| Up short | Faster target time | Next result page / leave | Move up |
| Down short | Slower target time | Previous result page / leave | Move down |
| Up long | Change measurement direction | - | - |

The menu currently contains:

- sensor sensitivity
- target time series
- result display duration
- OLED sleep timeout
- reset network

## Measurement modes

The firmware supports these shutter travel modes:

- `left`
- `down`
- `right`
- `up`
- `central`

The WebUI receives raw timestamps and sensor values. It performs its own timing and deviation calculations.

## Device status model

The firmware separates diagnostics into three categories:

- **Device errors**: device-level errors or degraded hardware status reported by `/status.deviceStatus`
- **Network hints**: non-blocking network diagnostics reported by `/status.network` and `/wifi/status`
- **Measurement hints**: diagnostics for the latest measurement reported by `/data.hint`

This keeps camera/shutter problems separate from device hardware or network problems.

## WiFi provisioning

On first boot, or if no valid station credentials are stored, the ESP32 starts the setup access point:

```text
SSID: OpenCurtainLab
Password: empty
Setup URL: http://192.168.4.1/
```

After successful provisioning the AP closes and the device is reachable through its station IP and, when mDNS is available, through:

```text
http://opencurtainlab.local/
```

The root page redirects to `WEB_APP_URL` in station mode. Captive portal probe paths serve the setup portal in AP mode.

## API

The firmware exposes a small JSON API used by the WebUI:

- `GET /status`
- `GET /config`
- `POST /config`
- `GET /data`
- `GET /sensors`
- `POST /calibrate`
- `GET /wifi/status`
- `GET /wifi/scan`
- `POST /wifi`

See [API.md](API.md) for request and response examples.

## Setup portal generation

The readable setup portal source lives in:

```text
src/setup_portal.html
```

The generated firmware header is:

```text
src/SetupPortalHtml.h
```

Rebuild the compressed header after editing the HTML:

```bash
python3 tools/build_setup_portal.py
```

The tool minifies the HTML, compresses it with gzip, and writes a `PROGMEM` byte array. The firmware serves it with `Content-Encoding: gzip`.


## WebUI source and single-file build

The WebUI is kept split during development and compiled into one self-contained HTML file for releases or local offline use.

Source layout:

```text
web/index.html              WebUI HTML shell
web/app.css                 Main UI and tutorial styling
web/app.js                  WebUI bootstrapping and event binding
web/js/i18n.js              Language loading and translations
web/js/utils.js             Shared formatting and file helpers
web/js/state-storage.js     App state, defaults, and localStorage
web/js/device-settings.js   ESP32 API, firmware settings, sensor tools
web/js/navigation.js        Main view switching, tutorial, language panel
web/js/measurements-projects.js Measurement ingestion and project lists
web/js/project-analysis.js  Project statistics and summary views
web/js/charts.js            Canvas timeline and curtain charts
web/js/backup-export-mock.js Backup/import, CSV export, notes, mock data
web/i18n/de.json            German UI strings
web/i18n/en.json            English UI strings
web/tutorial/de.html        German tutorial HTML fragment
web/tutorial/en.html        English tutorial HTML fragment
web/compiled/               Generated release HTML output
```

JavaScript source comments use simple `//` comments. The build script strips source comments from the compiled release file, but leaves the source files readable for development.

Tutorial files are HTML fragments only. They must not include `<!doctype>`, `<html>`, `<head>`, `<body>`, or local `<style>` blocks. Tutorial styling belongs in `web/app.css` so the guide reuses the same visual system as the WebUI.

Build the single-file WebUI with:

```bash
python3 tools/build_webui.py
```

The default output is:

```text
web/compiled/opencurtainlab.html
```

The compiled file embeds CSS, JavaScript, i18n JSON, and both tutorial fragments. It has no external asset dependencies and can be opened locally through `file://`.

For source-mode development, serve the `web` directory through a local web server so browser `fetch()` can load the JSON and tutorial fragment files:

```bash
cd web
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

The WebUI exposes this developer console command for live sensor diagnostics:

```js
oclSensors()
```

It fetches `GET /sensors`, prints the five phototransistor readings as a table, and returns the diagnostics JSON.

## Build notes

The firmware is an Arduino-style ESP32 sketch. Required libraries include:

- ESP32 Arduino core
- ArduinoJson
- Adafruit GFX Library
- Adafruit SSD1306

Keep the sketch folder name aligned with `OpenCurtainLab.ino` when using the Arduino IDE.

Before publishing a release, update these placeholders in `src/Config.h`:

```cpp
#define GITHUB_PROJECT_URL "https://github.com/your-user/OpenCurtainLab"
#define WEB_APP_URL        "https://your-user.github.io/OpenCurtainLab/en/"
```

Also choose and add a project license before publishing the repository.

## Release checklist

Before creating a public release:

- Build the sketch with the intended ESP32 board profile
- Test OLED initialization and local menu control
- Test lamp-jack protection by verifying that the lamp output stays off and `/status.deviceStatus.error` reports `lamp_connector_miswired` when the sense input is pulled low before arming
- Test baseline calibration with the final sensor hardware
- Test all five phototransistors and the flash-sync input
- Test all shutter travel modes
- Test setup AP on iOS, Android, Windows, and a normal browser
- Test WiFi provisioning, reconnect, AP fallback, and mDNS recovery
- Confirm `/status`, `/config`, `/data`, `/sensors`, `/calibrate`, and `/wifi/status` against the WebUI
- Update project URLs in `src/Config.h`
- Add license and release notes

## Repository layout

```text
OpenCurtainLab.ino          Main application controller
src/                        Firmware headers and generated setup portal header
src/setup_portal.html       Readable setup portal source
tools/build_setup_portal.py Setup portal minify/gzip generator
tools/build_webui.py        Single-file WebUI generator
web/                        WebUI source, i18n, tutorial fragments, compiled output
API.md                      HTTP API documentation
```
