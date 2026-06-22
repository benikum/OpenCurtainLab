# OpenCurtainLab

OpenCurtainLab is an ESP32-based shutter speed tester for focal-plane shutters. It reads five phototransistors and an optional flash-sync contact, exposes raw measurement data through a local HTTP API, and provides a standalone WebUI for analysis, projects, charts, import, and export.

## Current architecture

- **Firmware:** Arduino/ESP32 sketch with separated managers for sensors, measurement state, OLED display, buttons, WiFi provisioning, runtime settings, and HTTP API.
- **Sensor model:** Absolute ADC thresholds. A dark sensor is expected to read approximately `4095`; incoming light pulls the raw value downward. There is no calibration or stored baseline.
- **WebUI delivery:** The full WebUI is not embedded in firmware. In station mode, `GET /` resolves the compatible compiled WebUI through `web/manifest.json`, streams it through the ESP32 as `opencurtainlab.html`, without buffering it in firmware.
- **Setup portal:** The small WiFi setup portal is embedded as gzip-compressed PROGMEM HTML.
- **Runtime settings:** Stored in ESP32 Preferences and editable through local buttons or the WebUI.

## Hardware assumptions

The default pinout is defined in `src/Config.h`:

| Function | Pin |
|---|---:|
| Sensor 0 | 36 |
| Sensor 1 | 39 |
| Sensor 2 | 34 |
| Sensor 3 | 35 |
| Sensor 4 | 32 |
| Flash sync | 33 |
| Listen button | 25 |
| Up button | 26 |
| Down button | 27 |
| I2C SDA | 21 |
| I2C SCL | 22 |

The phototransistor circuit is expected to produce high ADC readings in darkness and lower ADC readings under light. Sensor detection uses hysteresis:

| Sensitivity | Active when raw is at or below | Released when raw is at or above |
|---|---:|---:|
| Low | 1100 | 1250 |
| Medium | 2100 | 2250 |
| High | 3100 | 3250 |

## Measurement flow

1. The device starts in `READY` and keeps the measurement engine armed unless a blocking device error exists.
2. Before arming, the engine scans sensors once. If any sensor is already active, arming is rejected with `sensor_already_active_at_start`.
3. The first sensor edge starts the critical capture window.
4. While capturing, the firmware prioritizes sensor polling and postpones normal WebUI/OLED work.
5. Open/close timestamps are stored per sensor in microseconds.
6. The result is exposed through `/data`; the WebUI calculates exposure values, deviations, curtain travel, and charts.

## API

See [`API.md`](API.md) for the current response format.

Important endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /` | Setup portal in AP mode; WebUI download through manifest proxy in station mode |
| `GET /status` | Device and network diagnostics |
| `GET /config` | Firmware capabilities and runtime settings |
| `POST /config` | Change runtime settings |
| `GET /data` | Latest raw measurement |
| `GET /sensors` | Live sensor diagnostics |
| `GET /version` | Manifest-selected compatible WebUI version |
| `GET /wifi/status` | Setup portal WiFi state |
| `GET /wifi/scan` | Setup portal network scan |
| `POST /wifi` | Store WiFi credentials only while setup AP is active |

Removed endpoint:

| Endpoint | Status |
|---|---|
| `POST /calibrate` | Removed. Sensor diagnostics are available through `GET /sensors`. |

## WebUI manifest

The manifest is the canonical release metadata file and the WebUI compatibility database:

```text
web/manifest.json
```

Example:

```json
{
  "schema": "opencurtainlab-web-manifest-v1",
  "projectVersion": "0.1.0",
  "entries": [
    {
      "match": "0.1.x",
      "version": "0.1.0",
      "url": "https://raw.githubusercontent.com/benikum/OpenCurtainLab/refs/heads/main/web/compiled/compiled-v0.1.0.html"
    }
  ]
}
```

Rules:

- `projectVersion` is the canonical version used by `tools/release.py`.
- `match` describes compatible firmware versions. `0.1.x` means any firmware with major `0` and API version `1`.
- The middle number is the API version and must match between firmware and WebUI.
- `version` is the actual WebUI version delivered to the browser.
- If multiple entries match, the firmware selects the highest bugfix version.

## Dependencies

See [`DEPENDENCIES.md`](DEPENDENCIES.md) for firmware libraries, development tools, WebUI runtime requirements, and hardware expectations.

## Build and release

Run:

```bash
python3 tools/release.py
```

The release helper:

1. reads `projectVersion` from `web/manifest.json`,
2. updates `FIRMWARE_VERSION` in `src/Config.h`,
3. updates `APP_VERSION` in `web/js/state-storage.js`,
4. rebuilds the embedded setup portal,
5. rebuilds the compiled standalone WebUI,
6. verifies that `web/manifest.json` contains a complete entry for the built WebUI.

The manifest itself is hand-maintained because it is the compatibility database.

## Generated files

These files are generated and should not be edited manually:

```text
src/SetupPortalHtml.h
web/compiled/compiled-v*.html
```

## Development checks

Useful checks before committing:

```bash
python3 tools/release.py
node --check web/app.js
node --check web/js/*.js
python3 -m json.tool web/manifest.json >/dev/null
python3 -m json.tool web/i18n/de.json >/dev/null
python3 -m json.tool web/i18n/en.json >/dev/null
```

A real firmware compile still requires the Arduino/ESP32 toolchain and the configured hardware libraries.

## Known weaknesses and items for future work

- The local WebUI API intentionally has no authentication. Anyone on the same local network can read diagnostics and change runtime settings through `/config`.
- The setup AP is open by default and WiFi credentials are submitted over HTTP. This is simple, but should only be used in a trusted local environment.
- `POST /wifi` is locked in station mode, but while setup AP mode is active anyone connected to the AP can submit credentials.
- `GET /` and `/version` fetch `web/manifest.json` with ESP32 TLS certificate validation disabled, then download the selected HTML without an additional integrity check.
- The manifest is hand-maintained. Wrong URLs or accidentally broad compatibility patterns can deliver the wrong WebUI.
- Sensor detection uses fixed ADC thresholds. This is simpler than calibration, but hardware variation, resistor values, ambient light leaks, ADC noise, and sensor placement can still require threshold tuning.
- ADC reads are sequential. At very fast shutter speeds, channel-to-channel read latency and loop jitter can affect timing accuracy.
- The ESP32 ADC is not a precision instrument. Results should be validated against a known timing reference before relying on absolute accuracy.
- The WebUI still contains inline event handlers in the HTML. Import IDs are hardened, but replacing inline handlers with delegated listeners would reduce long-term XSS and maintenance risk.
- The firmware still uses ArduinoJson v6-style APIs. A future migration to ArduinoJson 7 style would reduce deprecation warnings.
- The WebUI download depends on GitHub Raw availability unless the user already has a downloaded standalone HTML file.
- The firmware does not verify the integrity of the streamed WebUI. Use trusted release URLs and review `web/manifest.json` carefully.
