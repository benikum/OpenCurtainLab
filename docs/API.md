# OpenCurtainLab Firmware API

This document describes the current firmware HTTP API. All endpoints are served by the ESP32 on the local network.

## Security warning

OpenCurtainLab is designed for trusted local networks only. The firmware API is intentionally lightweight and does not provide user accounts, API tokens, HTTPS, request signing, or permission checks. The setup access point and local API should therefore be treated as physically local maintenance interfaces, not as internet-facing services.

Do not expose the device to the public internet, port-forward it from a router, place it on an untrusted guest network, or rely on it as a secure remote-control endpoint. Anyone who can reach the device on the network may be able to read status data, change runtime settings, access live sensor diagnostics, or start WiFi setup actions where available.

Recommended use:

- connect the device only to a private LAN you control
- keep it behind your router/firewall
- avoid public, shared, or guest WiFi networks
- disconnect or power down the device when it is not needed in an untrusted environment

## Base URLs

Station mode:

```text
http://opencurtainlab.local
```

or the station IP address shown on the OLED.

Setup access-point mode:

```text
http://192.168.4.1
```

API responses are JSON unless the endpoint description says otherwise. CORS preflight is supported for the documented API paths.

## Endpoint summary

| Method | Endpoint | Response type | Purpose |
|---|---|---|---|
| `GET` | `/` | HTML | Setup portal in AP mode; WebUI download proxy in station mode. |
| `GET` | `/status` | JSON | Device, network, uptime, measurement counter, battery, and error status. |
| `GET` | `/config` | JSON | Firmware capabilities and current runtime settings. |
| `POST` | `/config` | JSON | Partial runtime settings update. |
| `GET` | `/data` | JSON | Latest raw measurement packet. |
| `GET` | `/sensors` | JSON | Live sensor and flash diagnostics. |
| `GET` | `/version` | Plain text | Compatible WebUI version selected from the manifest. |
| `GET` | `/wifi/status` | JSON | WiFi provisioning state for the setup portal. |
| `GET` | `/wifi/scan` | JSON | Nearby WiFi networks for the setup portal. |
| `POST` | `/wifi` | JSON | Test and store WiFi credentials while AP mode is active. |

## Error response format

Most error responses use this compact format:

```json
{
  "ok": false,
  "error": "invalid_json"
}
```

Known error strings include:

| Error | Meaning |
|---|---|
| `missing_body` | A `POST` request did not contain a body. |
| `invalid_json` | The submitted JSON could not be parsed. |
| `sensors unavailable` | The sensor manager is not attached. |
| `ssid missing` | WiFi setup request did not include an SSID. |
| `wifi_setup_locked_in_station_mode` | `/wifi` was called while the device was not in setup AP mode. |
| `not found` | Unknown route in station mode. |

## `GET /`

In setup AP mode, root serves the embedded WiFi setup portal.

In station mode, root fetches `web/manifest.json`, selects the newest compatible compiled WebUI entry, downloads the compiled HTML, and returns it to the browser as an attachment:

```http
Content-Disposition: attachment; filename="opencurtainlab.html"
Content-Type: text/html; charset=utf-8
```

The full WebUI is not embedded in firmware. The embedded firmware only contains the small setup portal.

## `GET /status`

Returns runtime status.

```bash
curl http://opencurtainlab.local/status
```

Example response:

```json
{
  "device": "OpenCurtainLab",
  "version": "0.1.0",
  "uptime": 1234,
  "measCount": 7,
  "batteryVoltage": 8.62,
  "batteryLow": false,
  "deviceStatus": {
    "error": "none",
    "errorText": "",
    "subsystem": "none"
  },
  "network": {
    "connected": true,
    "apMode": false,
    "ip": "192.168.178.42",
    "apIp": "0.0.0.0",
    "hostname": "opencurtainlab",
    "mdns": "opencurtainlab.local",
    "mdnsStarted": true,
    "rssi": -54,
    "savedSsid": "WorkshopWiFi",
    "currentSsid": "WorkshopWiFi",
    "hint": "none",
    "hintText": ""
  }
}
```

Fields:

| Field | Type | Description |
|---|---|---|
| `device` | string | Device name. |
| `version` | string | Firmware version. |
| `uptime` | integer | Seconds since boot. |
| `measCount` | integer | Number of measurement results produced since boot. |
| `batteryVoltage` | number | Calculated battery voltage, or `0` when battery monitoring is disabled. |
| `batteryLow` | boolean | `true` when battery monitoring is enabled and voltage is at or below `BATTERY_EMPTY_VOLTAGE`. |
| `deviceStatus` | object | Device-level error state. |
| `network` | object | Current WiFi and mDNS state. |

Device error keys:

| Key | Meaning |
|---|---|
| `none` | No device error. |
| `network_access_point_failed` | Setup access point could not be started. |
| `display_init_failed` | OLED initialization failed. Measurement and API can continue. |

Device subsystem keys:

| Key |
|---|
| `none` |
| `sensor` |
| `network` |
| `storage` |
| `display` |

Network hint keys:

| Key | Meaning |
|---|---|
| `none` | No network hint. |
| `no_credentials` | No saved WiFi credentials. |
| `access_point_active` | Setup AP is active. |
| `connection_failed` | Station connection failed or AP fallback is active. |
| `reconnecting` | Device is trying to reconnect. |
| `mdns_failed` | Station WiFi works, but mDNS failed. |

## `GET /config`

Returns firmware capabilities and sanitized runtime settings.

```bash
curl http://opencurtainlab.local/config
```

Example response:

```json
{
  "device": "OpenCurtainLab",
  "version": "0.1.0",
  "ip": "192.168.178.42",
  "mdnsName": "opencurtainlab",
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "displayRotation": 0,
  "sensorCount": 5,
  "maxTargetTime": 2000,
  "batteryVoltageEnabled": true,
  "batteryEmptyVoltage": 7.0,
  "batteryFullVoltage": 9.3,
  "sensorReadModel": "absolute_adc_threshold",
  "sensorThresholds": {
    "lowOnRaw": 1100,
    "lowOffRaw": 1250,
    "mediumOnRaw": 2100,
    "mediumOffRaw": 2250,
    "highOnRaw": 3100,
    "highOffRaw": 3250
  },
  "targetSeriesOptions": ["standard", "custom"],
  "targetTimesStandard": [1, 2, 4, 8, 15, 30, 60, 125, 250, 500, 1000, 2000],
  "targetTimesCustom": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  "modes": ["vertical", "horizontal", "central"],
  "settings": {
    "defaultMeasurementMode": "horizontal",
    "defaultTargetTime": 500,
    "sensorSensitivity": "medium",
    "resultDisplay": "until_button",
    "targetSeries": "standard",
    "customTargetTimes": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
    "oledSleepMinutes": 5
  },
  "githubProjectUrl": "https://github.com/benikum/OpenCurtainLab",
  "webManifestUrl": "https://raw.githubusercontent.com/benikum/OpenCurtainLab/refs/heads/main/web/manifest.json",
  "webAppDelivery": "manifest_proxy"
}
```

Capability fields:

| Field | Type | Description |
|---|---|---|
| `sensorDistanceXmm` | number | Physical sensor spacing for horizontal travel mode. |
| `sensorDistanceYmm` | number | Physical sensor spacing for vertical travel mode. |
| `displayRotation` | integer | OLED rotation from firmware config. |
| `sensorCount` | integer | Number of sensor channels. |
| `maxTargetTime` | integer | Maximum accepted target denominator. |
| `batteryVoltageEnabled` | boolean | Whether firmware battery monitoring is enabled. |
| `batteryEmptyVoltage` | number | Voltage used as empty/low reference. |
| `batteryFullVoltage` | number | Voltage used as full reference. |
| `sensorReadModel` | string | Current sensor model. `absolute_adc_threshold` means no calibration baseline is used. |
| `sensorThresholds` | object | Raw ADC hysteresis thresholds for sensitivity presets. |
| `targetSeriesOptions` | string array | Supported target speed series. |
| `targetTimesStandard` | integer array | Built-in standard shutter speed denominators. |
| `targetTimesCustom` | integer array | Current custom shutter speed denominators. |
| `modes` | string array | Supported measurement modes. |

Runtime settings object:

| Field | Type | Values |
|---|---|---|
| `defaultMeasurementMode` | string | `vertical`, `horizontal`, `central` |
| `defaultTargetTime` | integer | Exposure denominator, for example `500` for 1/500 s. |
| `sensorSensitivity` | string | `low`, `medium`, `high` |
| `resultDisplay` | string | `until_button`, `2s`, `5s`, `10s`, `none` |
| `targetSeries` | string | `standard`, `custom` |
| `customTargetTimes` | integer array | Positive exposure denominators. |
| `oledSleepMinutes` | integer | `0`, `1`, `5`, `10`, `30` |

## `POST /config`

Applies a partial runtime-settings update. Omitted fields are left unchanged.

```bash
curl -X POST http://opencurtainlab.local/config \
  -H "Content-Type: application/json" \
  -d '{"sensorSensitivity":"high","defaultTargetTime":250}'
```

Accepted fields:

| Field | Type | Values |
|---|---|---|
| `defaultMeasurementMode` | string | `vertical`, `horizontal`, `central` |
| `defaultTargetTime` | integer | Exposure denominator. Sanitized to the nearest supported target time. |
| `sensorSensitivity` | string | `low`, `medium`, `high` |
| `resultDisplay` | string | `until_button`, `2s`, `5s`, `10s`, `none` |
| `targetSeries` | string | `standard`, `custom` |
| `customTargetTimes` | integer array | Positive denominators, sorted and de-duplicated by firmware. |
| `oledSleepMinutes` | integer | `0`, `1`, `5`, `10`, `30` |

Successful response:

```json
{
  "ok": true,
  "changed": true,
  "settings": {
    "defaultMeasurementMode": "horizontal",
    "defaultTargetTime": 250,
    "sensorSensitivity": "high",
    "resultDisplay": "until_button",
    "targetSeries": "standard",
    "customTargetTimes": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
    "oledSleepMinutes": 5
  }
}
```

Notes:

- `maxTargetTime` is a build-time capability and is ignored if posted.
- Invalid enum values fall back to firmware defaults during sanitization.
- Custom target times are sorted, de-duplicated, capped by firmware limits, and filtered against `maxTargetTime`.
- If the request body is syntactically valid JSON but contains no effective change, `changed` is `false`.

## `GET /data`

Returns the latest raw measurement packet. Exposure analysis is intentionally performed in the WebUI.

```bash
curl http://opencurtainlab.local/data
```

Before the first measurement:

```json
{
  "measCount": 0,
  "mode": "horizontal",
  "target": 500,
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "valid": false,
  "hint": "none",
  "hintText": ""
}
```

Example valid measurement:

```json
{
  "measCount": 7,
  "mode": "horizontal",
  "target": 500,
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "valid": true,
  "id": "m_123456_7",
  "baseUs": 987654321,
  "sensors": [
    { "id": 0, "activated": true, "raw": 420, "openUs": 987654321, "closeUs": 987656400 },
    { "id": 1, "activated": true, "raw": 390, "openUs": 987654450, "closeUs": 987656530 },
    { "id": 2, "activated": true, "raw": 430, "openUs": 987654600, "closeUs": 987656680 },
    { "id": 3, "activated": true, "raw": 410, "openUs": 987654750, "closeUs": 987656830 },
    { "id": 4, "activated": true, "raw": 405, "openUs": 987654900, "closeUs": 987656980 }
  ],
  "hint": "none",
  "hintText": "",
  "flash": {
    "detected": true,
    "raw": 0,
    "triggerUs": 987654100
  }
}
```

Top-level fields:

| Field | Type | Description |
|---|---|---|
| `measCount` | integer | Measurement counter since boot. |
| `mode` | string | Measurement mode used for the packet. |
| `target` | integer | Target shutter denominator. |
| `sensorDistanceXmm` | number | Horizontal sensor spacing used by the WebUI. |
| `sensorDistanceYmm` | number | Vertical sensor spacing used by the WebUI. |
| `valid` | boolean | Whether the packet contains a measurement result. |
| `id` | string | Measurement id. Present only after a result exists. |
| `baseUs` | integer | Base timestamp in microseconds. Present only after a result exists. |
| `sensors` | array | Raw per-sensor result objects. Present only after a result exists. |
| `hint` | string | Measurement hint key. |
| `hintText` | string | Human-readable hint text. |
| `flash` | object | Flash-sync result. Present only after a result exists. |

Sensor result fields:

| Field | Type | Description |
|---|---|---|
| `id` | integer | Sensor index, starting at `0`. |
| `activated` | boolean | Whether this sensor was covered during the measurement. |
| `raw` | integer | Last raw ADC value for this sensor. |
| `openUs` | integer | Timestamp when the sensor became active. |
| `closeUs` | integer | Timestamp when the sensor became inactive again. |

Flash result fields:

| Field | Type | Description |
|---|---|---|
| `detected` | boolean | Whether the flash contact was triggered. |
| `raw` | integer | Last raw digital input value. |
| `triggerUs` | integer | Trigger timestamp in microseconds. |

Measurement hint keys:

| Key | Meaning |
|---|---|
| `none` | No measurement hint. |
| `sensor_already_active_at_start` | A sensor was already active while arming. |
| `flash_already_active_at_start` | Flash input was already active while arming. |
| `flash_without_sensor` | Flash input fired but no sensor was covered. |
| `timeout_with_data` | Measurement timed out after partial data. |
| `incomplete_sensor_coverage` | Not all five sensors were covered. |

## `GET /sensors`

Returns a live, non-mutating diagnostics snapshot. Diagnostic reads do not create measurement edges.

```bash
curl http://opencurtainlab.local/sensors
```

Example response:

```json
{
  "ok": true,
  "timeUs": 123456789,
  "sensorCount": 5,
  "onThresholdRaw": 2100,
  "offThresholdRaw": 2250,
  "sensors": [
    {
      "id": 0,
      "pin": 36,
      "raw": 4095,
      "onThresholdRaw": 2100,
      "offThresholdRaw": 2250,
      "active": false,
      "trackedActive": false,
      "wasActivated": false,
      "openUs": 0,
      "closeUs": 0
    }
  ],
  "flash": {
    "pin": 14,
    "raw": 1,
    "active": false,
    "trackedActive": false,
    "detected": false,
    "triggerUs": 0
  }
}
```

In the WebUI developer console, `oclSensors()` prints the sensor diagnostics as a table when developer helpers are enabled.

## `GET /version`

Returns the compatible WebUI version as plain text.

```bash
curl -i http://opencurtainlab.local/version
```

Example success response:

```http
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
X-OpenCurtainLab-Version-Source: manifest
X-OpenCurtainLab-WebUI-Match: 0.1.x

0.1.0
```

If manifest lookup fails, the firmware returns the local firmware version with:

```http
X-OpenCurtainLab-Version-Source: local-fallback
```

## `GET /wifi/status`

Returns WiFi provisioning state for the setup portal.

```bash
curl http://192.168.4.1/wifi/status
```

Example response:

```json
{
  "ok": true,
  "connected": false,
  "apMode": true,
  "ip": "0.0.0.0",
  "apIp": "192.168.4.1",
  "hostname": "opencurtainlab",
  "mdnsStarted": false,
  "hasSaved": false,
  "savedSsid": "",
  "currentSsid": "",
  "hint": "access_point_active",
  "hintText": "Setup access point is active",
  "lastError": ""
}
```

## `GET /wifi/scan`

Returns nearby WiFi networks for the setup portal.

```bash
curl http://192.168.4.1/wifi/scan
```

Example response:

```json
{
  "ok": true,
  "networks": [
    { "ssid": "WorkshopWiFi", "rssi": -51, "secure": true },
    { "ssid": "Guest", "rssi": -78, "secure": false }
  ]
}
```

## `POST /wifi`

Tests and stores WiFi credentials only while setup AP mode is active.

JSON request:

```bash
curl -X POST http://192.168.4.1/wifi \
  -H "Content-Type: application/json" \
  -d '{"ssid":"WorkshopWiFi","password":"secret-password"}'
```

Form-style fields are also accepted by the firmware.

Successful or failed connection test response uses the same shape as `/wifi/status`. On failed connection, `ok` is `false` and `error` is set:

```json
{
  "ok": false,
  "connected": false,
  "apMode": true,
  "ip": "0.0.0.0",
  "apIp": "192.168.4.1",
  "hostname": "opencurtainlab",
  "mdnsStarted": false,
  "hasSaved": false,
  "savedSsid": "",
  "currentSsid": "",
  "hint": "connection_failed",
  "hintText": "WiFi connection failed",
  "lastError": "connection failed",
  "error": "connection failed"
}
```

When called in station mode:

```json
{
  "ok": false,
  "error": "wifi_setup_locked_in_station_mode"
}
```

## WebUI manifest

The WebUI compatibility database is stored in:

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

Selection rules:

- `projectVersion` is the canonical project version used by `tools/release.py`.
- `match` is the firmware compatibility pattern, such as `0.1.x`.
- `version` is the WebUI release selected for compatible firmware.
- The middle version number is treated as the API version.
- If multiple entries match, the firmware selects the highest patch version.
