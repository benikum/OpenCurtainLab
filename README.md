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

- `vertical`
- `horizontal`
- `central`

The WebUI receives raw timestamps, sensor values, and the sensor geometry with each measurement. It performs its own timing, deviation, and curtain-speed calculations.

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

In station mode, the root page tries to proxy the versioned single-file WebUI from `WEB_APP_URL` and returns it as `text/html` from the ESP32 origin. The proxied client-facing filename remains `opencurtainlab.html`. If the proxy request fails, the firmware falls back to a normal redirect to `WEB_APP_URL`. Captive portal probe paths serve the setup portal in AP mode.

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

The tool resolves paths from the repository root, so it can be started from any working directory. If a file is not found, run it with debug output:

```bash
python3 tools/build_setup_portal.py --debug
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
web/js/backup-export.js      Backup/import, CSV export, notes, mock data
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

The tool resolves all source paths from the repository root, so it can be started from any working directory. For path diagnostics:

```bash
python3 tools/build_webui.py --debug
```

You can also enable the same diagnostics with:

```bash
OCL_DEBUG=1 python3 tools/build_webui.py
```

The default output is:

```text
web/compiled/compiled-v0.1.0.html
```

The compiled file embeds CSS, JavaScript, i18n JSON, and both tutorial fragments. It has no external asset dependencies and can be opened locally through `file://`. Firmware fetches the versioned file matching `FIRMWARE_VERSION`; the ESP32 proxy still presents it to the browser as `opencurtainlab.html`.

For source-mode development, serve the `web` directory through the helper script so browser `fetch()` can load the JSON and tutorial fragment files:

```bash
python3 tools/serve_webui.py
```

For path diagnostics:

```bash
python3 tools/serve_webui.py --debug
```

Open `http://127.0.0.1:8000/`.

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

## Development transparency

OpenCurtainLab is a hardware-tested project developed and maintained by the author.

AI tools were used during development as an assistant for code review, refactoring, documentation, and exploring implementation options. The project is not generated and published without review: hardware behavior, firmware changes, API behavior, and measurement results are checked manually before release.

All design decisions, project direction, and release responsibility remain with the maintainer.