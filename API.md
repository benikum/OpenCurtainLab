# OpenCurtainLab Firmware API

Base URL in station mode:

```text
http://opencurtainlab.local
```

or the station IP reported by the device.

Base URL in setup AP mode:

```text
http://192.168.4.1
```

All API responses are JSON. CORS preflight is supported for the documented endpoints.

## Status model

The firmware separates diagnostics into three categories:

| Category | Location | Meaning |
|---|---|---|
| Device error | `/status.deviceStatus` | Device-level problem or degraded hardware status |
| Network hint | `/status.network` and `/wifi/status` | Non-blocking WiFi or mDNS diagnostic |
| Measurement hint | `/data.hint` | Diagnostic for the latest measurement |


## `GET /status`

Returns device, network, uptime, measurement counter, and diagnostics.

### Request

```bash
curl http://opencurtainlab.local/status
```

### Example response

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

### Device errors

| Key | Meaning |
|---|---|
| `none` | No device error |
| `sensor_baseline_too_low` | Sensor baseline is too low for reliable measurement |
| `network_access_point_failed` | Setup access point could not be started |
| `display_init_failed` | OLED display initialization failed; measurement and API can still work |
| `lamp_connector_miswired` | Lamp connector sense line is low; lamp output is kept off to prevent a short through the flash contact |

### Device subsystems

```text
none
sensor
network
storage
display
lamp
```

`storage` is reserved as a subsystem key for future diagnostics. `lamp` is used for lamp-jack protection diagnostics.

### Network hints

| Key | Meaning |
|---|---|
| `none` | No network hint |
| `no_credentials` | No saved WiFi credentials |
| `access_point_active` | Setup AP is active |
| `connection_failed` | Station connection failed or AP fallback is active |
| `reconnecting` | Device is trying to reconnect |
| `mdns_failed` | Station WiFi works, but mDNS failed |

## `GET /config`

Returns firmware capabilities and current runtime settings.

### Request

```bash
curl http://opencurtainlab.local/config
```

### Example response

```json
{
  "device": "OpenCurtainLab",
  "version": "0.1.0",
  "mdnsName": "opencurtainlab",
  "sensorDistanceXmm": 13.17,
  "sensorDistanceYmm": 7.67,
  "displayRotation": 2,
  "sensorCount": 5,
  "maxTargetTime": 2000,
  "baselineSamples": 5,
  "baselineDurationMs": 250,
  "targetSeriesOptions": ["standard", "custom"],
  "targetTimesStandard": [1, 2, 4, 8, 15, 30, 60, 125, 250, 500, 1000, 2000],
  "targetTimesCustom": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  "targetTimes": [1, 2, 4, 8, 15, 30, 60, 125, 250, 500, 1000, 2000],
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
  "webAppUrl": "https://raw.githubusercontent.com/benikum/OpenCurtainLab/refs/heads/main/web/compiled/compiled-v0.1.0.html"
}
```

`maxTargetTime` is a firmware capability. It is not a runtime setting and is not stored in preferences.

## `POST /config`

Applies partial runtime settings. Only fields that should change need to be sent.

### Request

```bash
curl -X POST http://opencurtainlab.local/config \
  -H "Content-Type: application/json" \
  -d '{
    "defaultMeasurementMode": "vertical",
    "defaultTargetTime": 250,
    "sensorSensitivity": "high",
    "resultDisplay": "5s",
    "targetSeries": "custom",
    "customTargetTimes": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
    "oledSleepMinutes": 10
  }'
```

### Example response

```json
{
  "ok": true,
  "changed": true,
  "settings": {
    "defaultMeasurementMode": "vertical",
    "defaultTargetTime": 250,
    "sensorSensitivity": "high",
    "resultDisplay": "5s",
    "targetSeries": "custom",
    "customTargetTimes": [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
    "oledSleepMinutes": 10
  }
}
```

### Accepted fields

| Field | Type | Values |
|---|---|---|
| `defaultMeasurementMode` | string | `vertical`, `horizontal`, `central` |
| `defaultTargetTime` | integer | Exposure denominator, for example `500` for 1/500 s |
| `sensorSensitivity` | string | `low`, `medium`, `high` |
| `resultDisplay` | string | `until_button`, `2s`, `5s`, `10s`, `none` |
| `targetSeries` | string | `standard`, `custom` |
| `customTargetTimes` | integer array | Positive exposure denominators up to `maxTargetTime` |
| `oledSleepMinutes` | integer | `0`, `1`, `5`, `10`, `30` |

`maxTargetTime` is intentionally ignored if posted.

Custom target times are de-duplicated, sorted, limited to `TARGET_TIMES_MAX_COUNT`, and filtered against `maxTargetTime`.

## `GET /data`

Returns the latest raw measurement. The WebUI calculates exposure times, deviations, travel, and charts from these raw values.

### Request

```bash
curl http://opencurtainlab.local/data
```

### Response before the first measurement

```json
{
  "measCount": 0,
  "mode": "horizontal",
  "target": 500,
  "valid": false
}
```

### Example measurement response

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
    { "id": 0, "activated": true, "raw": 2340, "baseline": 3150, "openUs": 987654321, "closeUs": 987656400 },
    { "id": 1, "activated": true, "raw": 2310, "baseline": 3140, "openUs": 987654450, "closeUs": 987656530 },
    { "id": 2, "activated": true, "raw": 2290, "baseline": 3130, "openUs": 987654600, "closeUs": 987656680 },
    { "id": 3, "activated": true, "raw": 2280, "baseline": 3125, "openUs": 987654750, "closeUs": 987656830 },
    { "id": 4, "activated": true, "raw": 2275, "baseline": 3120, "openUs": 987654900, "closeUs": 987656980 }
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

### Measurement hints

| Key | Meaning |
|---|---|
| `none` | No measurement hint |
| `sensor_already_active_at_start` | A sensor was already active while arming |
| `flash_without_sensor` | Flash input fired but no sensor was covered |
| `timeout_with_data` | Measurement timed out after partial data |
| `incomplete_sensor_coverage` | Not all five sensors were covered |

## `GET /sensors`

Returns a live diagnostics snapshot of the five phototransistors and the flash contact.
The sensor ADC reads are non-mutating diagnostics reads: they do not create measurement edges or change the current capture tracking.

This endpoint is intended for developer tools, calibration checks, and hardware bring-up.

### Request

```bash
curl http://opencurtainlab.local/sensors
```

### Example response

```json
{
  "ok": true,
  "timeUs": 123456789,
  "sensorCount": 5,
  "onDelta": 2000,
  "offDelta": 1900,
  "sensors": [
    {
      "id": 0,
      "pin": 36,
      "raw": 3820,
      "baseline": 3920,
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

In the WebUI developer console, run:

```js
oclSensors()
```

The command fetches `/sensors`, prints the five sensors as a table, and returns the JSON object.

## `POST /calibrate`

Recalibrates the phototransistor baselines. The app-level callback stops the capture engine, samples new baselines, updates device error state, and rearms the device when possible.

Use this after changing lighting, covers, or sensor-board position.

### Request

```bash
curl -X POST http://opencurtainlab.local/calibrate
```

### Example response

```json
{
  "ok": true,
  "calibrated": true,
  "baselines": [3920, 3908, 3914, 3899, 3926]
}
```

If calibration fails, the firmware returns `500` and sets the sensor device error reported by `/status`.

## `GET /wifi/status`

Returns provisioning and station status for the setup portal.

### Request

```bash
curl http://192.168.4.1/wifi/status
```

### Example response

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
  "hint": "no_credentials",
  "hintText": "No saved WiFi credentials",
  "lastError": ""
}
```

## `GET /wifi/scan`

Scans nearby 2.4 GHz networks.

### Request

```bash
curl http://192.168.4.1/wifi/scan
```

### Example response

```json
{
  "ok": true,
  "networks": [
    { "ssid": "MyWiFi", "rssi": -51, "secure": true },
    { "ssid": "Guest", "rssi": -78, "secure": true },
    { "ssid": "OpenNetwork", "rssi": -82, "secure": false }
  ]
}
```

## `POST /wifi`

Tests WiFi credentials and saves them only if the connection succeeds.

### JSON request

```bash
curl -X POST http://192.168.4.1/wifi \
  -H "Content-Type: application/json" \
  -d '{
    "ssid": "MyWiFi",
    "password": "secret-password"
  }'
```

### Form request

```bash
curl -X POST http://192.168.4.1/wifi \
  -d "ssid=MyWiFi" \
  -d "password=secret-password"
```

For an open network, send an empty password.

### Successful response

```json
{
  "ok": true,
  "connected": true,
  "apMode": true,
  "apIp": "192.168.4.1",
  "hostname": "opencurtainlab",
  "mdnsStarted": false,
  "hasSaved": true,
  "savedSsid": "MyWiFi",
  "currentSsid": "MyWiFi",
  "hint": "access_point_active",
  "hintText": "Setup access point is active",
  "lastError": ""
}
```

`apMode` can remain `true` briefly after successful provisioning. The setup AP closes automatically shortly afterwards.

### Missing SSID response

```json
{
  "ok": false,
  "error": "ssid missing"
}
```

### Failed connection response

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
  "hintText": "Connection failed. Setup access point is active.",
  "lastError": "Connection failed. Check password or use a 2.4 GHz network.",
  "error": "connection failed"
}
```

## Captive portal and root routes

In AP mode these paths serve the setup portal:

```text
/
/generate_204
/hotspot-detect.html
/fwlink
/connecttest.txt
/ncsi.txt
```

In station mode the same browser-style root routes try to proxy the versioned remote single-file WebUI from `WEB_APP_URL` and serve it as `text/html` from the ESP32 origin. The proxied response keeps the client-facing filename `opencurtainlab.html`. If the proxy fails before response headers are sent, the firmware falls back to a normal redirect to `WEB_APP_URL`.

## CORS preflight

The firmware registers `OPTIONS` handlers for:

```text
/data
/status
/config
/sensors
/calibrate
/wifi
/wifi/scan
/wifi/status
```

Responses are empty `204` responses with CORS headers.
