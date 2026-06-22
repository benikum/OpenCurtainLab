# OpenCurtainLab Firmware API

Base URL in station mode:

```text
http://opencurtainlab.local
```

or the station IP shown on the OLED. In setup AP mode the base URL is:

```text
http://192.168.4.1
```

API responses are JSON unless noted otherwise. CORS preflight is supported. There is one current response format; legacy compatibility fields and the old calibration endpoint have been removed.

## `GET /`

In setup AP mode, root serves the embedded WiFi setup portal.

In station mode, root downloads `web/manifest.json`, selects the newest compatible WebUI entry, downloads that compiled HTML file and returns it to the browser as:

```http
Content-Disposition: attachment; filename="opencurtainlab.html"
```

The firmware does not embed the full WebUI because the compiled file is too large for the intended firmware image.

## `GET /status`

Returns device, network, uptime, measurement counter, and diagnostics.

```bash
curl http://opencurtainlab.local/status
```

```json
{
  "device": "OpenCurtainLab",
  "version": "0.1.0",
  "uptime": 1234,
  "measCount": 7,
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
    "savedSsid": "MyWiFi",
    "currentSsid": "MyWiFi",
    "hint": "none",
    "hintText": ""
  }
}
```

Device error keys:

| Key | Meaning |
|---|---|
| `none` | No device error |
| `network_access_point_failed` | Setup access point could not be started |
| `display_init_failed` | OLED display initialization failed; API and measurement can continue without local display |

Network hint keys:

| Key | Meaning |
|---|---|
| `none` | No network hint |
| `no_credentials` | No saved WiFi credentials |
| `access_point_active` | Setup AP is active |
| `connection_failed` | Station connection failed or AP fallback is active |
| `reconnecting` | Device is trying to reconnect |
| `mdns_failed` | Station WiFi works, but mDNS failed |

## `GET /config`

Returns firmware capabilities and current runtime settings. Sensor detection uses absolute ADC thresholds. There is no calibration, no stored dark baseline, and no separate dark-reference config field. A dark sensor is expected to read approximately `4095`; light should pull the ADC value downward.

```json
{
  "device": "OpenCurtainLab",
  "version": "0.1.0",
  "ip": "192.168.178.42",
  "mdnsName": "opencurtainlab",
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "displayRotation": 2,
  "sensorCount": 5,
  "maxTargetTime": 2000,
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

## `POST /config`

Applies partial runtime settings.

```bash
curl -X POST http://opencurtainlab.local/config \
  -H "Content-Type: application/json" \
  -d '{"sensorSensitivity":"high","defaultTargetTime":250}'
```

Accepted fields:

| Field | Type | Values |
|---|---|---|
| `defaultMeasurementMode` | string | `vertical`, `horizontal`, `central` |
| `defaultTargetTime` | integer | Exposure denominator, for example `500` for 1/500 s |
| `sensorSensitivity` | string | `low`, `medium`, `high` |
| `resultDisplay` | string | `until_button`, `2s`, `5s`, `10s`, `none` |
| `targetSeries` | string | `standard`, `custom` |
| `customTargetTimes` | integer array | Positive exposure denominators up to `maxTargetTime` |
| `oledSleepMinutes` | integer | `0`, `1`, `5`, `10`, `30` |

`maxTargetTime` is intentionally ignored if posted. Custom target times are de-duplicated, sorted, limited to `TARGET_TIMES_MAX_COUNT`, and filtered against `maxTargetTime`.

## `GET /data`

Returns the latest raw measurement. The WebUI calculates exposure times, deviations, travel, and charts from these raw values. Clients should store only packets with `valid: true`; measurement hints on valid packets should be preserved.

Before the first measurement:

```json
{
  "measCount": 0,
  "mode": "horizontal",
  "target": 500,
  "valid": false,
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "hint": "none",
  "hintText": ""
}
```

Example measurement:

```json
{
  "measCount": 7,
  "mode": "horizontal",
  "target": 500,
  "valid": true,
  "id": "m_123456_7",
  "baseUs": 987654321,
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
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

Measurement hint keys:

| Key | Meaning |
|---|---|
| `none` | No measurement hint |
| `sensor_already_active_at_start` | A sensor was already active while arming |
| `flash_already_active_at_start` | Flash input was already active while arming |
| `flash_without_sensor` | Flash input fired but no sensor was covered |
| `timeout_with_data` | Measurement timed out after partial data |
| `incomplete_sensor_coverage` | Not all five sensors were covered |

## `GET /sensors`

Returns a live diagnostics snapshot. The diagnostic reads do not create measurement edges and do not change capture tracking.

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
    "pin": 33,
    "raw": 1,
    "active": false,
    "trackedActive": false,
    "detected": false,
    "triggerUs": 0
  }
}
```

In the WebUI developer console, run `oclSensors()` to print the five sensors as a table.

## `GET /version`

Returns the manifest-selected compatible WebUI version as plain text. The ESP32 fetches `web/manifest.json`, selects the newest entry whose `match` pattern fits the firmware and whose middle version number matches the firmware API version, then returns that entry's `version`. If the manifest cannot be fetched or no compatible entry exists, the firmware returns the local firmware version with HTTP 200 and header `X-OpenCurtainLab-Version-Source: local-fallback`.

Headers on manifest success:

```http
X-OpenCurtainLab-Version-Source: manifest
X-OpenCurtainLab-WebUI-Match: 0.1.x
```

## WebUI manifest

The hand-maintained compatibility database is stored at:

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

- `projectVersion` is the canonical version used by `tools/release.py` for the firmware and WebUI build.
- `match` is the firmware compatibility pattern. It can be exact, for example `0.1.0`, or a patch wildcard, for example `0.1.x`.
- `version` is the actual WebUI version that will be served.
- The middle version number is the API version. Firmware `0.1.0` may use WebUI `0.1.3`, but not `0.2.0`.
- If several entries match, the firmware selects the highest bugfix number in `version`.

## `GET /wifi/status`

Returns provisioning and station status for the setup portal.

## `GET /wifi/scan`

Returns nearby networks for the setup portal.

## `POST /wifi`

Tests and stores WiFi credentials only while the setup AP is active. In station mode this endpoint returns `403` with:

```json
{ "ok": false, "error": "wifi_setup_locked_in_station_mode" }
```

## Removed endpoint

`POST /calibrate` has been removed. There is no calibration step. Sensor diagnostics are available through `GET /sensors`.

## Security and operational notes

- The local API intentionally has no authentication.
- Anyone who can reach the device on the local network can read diagnostics and change runtime settings through `/config`.
- WiFi credentials can only be submitted through `/wifi` while the setup AP is active.
- The setup AP is open by default and setup credentials are posted over HTTP.
- Root WebUI delivery and `/version` fetch `web/manifest.json` with ESP32 TLS certificate validation disabled, then download the selected WebUI file without an additional integrity check.
- The WebUI manifest must point to trusted compiled HTML files.
