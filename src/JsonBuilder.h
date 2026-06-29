/*
 * Builds all JSON payloads returned by the HTTP API from runtime status, settings, and raw measurement data.
 */

#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include "Config.h"
#include "TargetTimes.h"
#include "RuntimeSettings.h"
#include "SensorManager.h"
#include "MeasurementTypes.h"

struct DeviceStatusView {
  bool connected = false;
  bool apMode = false;
  bool mdnsStarted = false;
  String ip;
  String apIp;
  String hostname = MDNS_NAME;
  String mdns = MDNS_NAME ".local";
  String savedSsid;
  String currentSsid;
  uint32_t measurementId = 0;
  DeviceStatus deviceStatus;
  NetworkHint networkHint = NetworkHint::None;
  float batteryVoltage = 0.0f;
};

struct WifiStatusView {
  bool ok = true;
  bool connected = false;
  bool apMode = false;
  bool mdnsStarted = false;
  bool hasSaved = false;
  String ip;
  String apIp;
  String hostname = MDNS_NAME;
  String savedSsid;
  String currentSsid;
  String lastError;
  NetworkHint hint = NetworkHint::None;
  const char* error = nullptr;
};

class JsonBuilder {
public:
  // Builds the /status JSON response.
  static String status(const DeviceStatusView& view) {
    JsonDocument doc;
    const String mdnsName = view.mdns.length() ? view.mdns : String(MDNS_NAME ".local");
    const int rssi = view.connected ? WiFi.RSSI() : 0;

    doc["device"] = DEVICE_NAME;
    doc["version"] = FIRMWARE_VERSION;
    doc["uptime"] = millis() / 1000;
    doc["measCount"] = view.measurementId;
    const uint32_t centivolts = (uint32_t)((view.batteryVoltage * 100.0f) + 0.5f);
    const float roundedBatteryVoltage = (float)centivolts / 100.0f;
    doc["batteryVoltage"] = roundedBatteryVoltage;
    doc["batteryLow"] = BATTERY_MONITOR_ENABLED && roundedBatteryVoltage > 0.0f && roundedBatteryVoltage <= BATTERY_EMPTY_VOLTAGE;

    JsonObject deviceStatus = doc["deviceStatus"].to<JsonObject>();
    deviceStatus["error"] = deviceErrorKey(view.deviceStatus.error);
    deviceStatus["errorText"] = deviceErrorText(view.deviceStatus.error);
    deviceStatus["subsystem"] = deviceSubsystemKey(view.deviceStatus.subsystem);

    JsonObject network = doc["network"].to<JsonObject>();
    network["connected"] = view.connected;
    network["apMode"] = view.apMode;
    network["ip"] = view.ip;
    network["apIp"] = view.apIp;
    network["hostname"] = view.hostname.length() ? view.hostname : String(MDNS_NAME);
    network["mdns"] = mdnsName;
    network["mdnsStarted"] = view.mdnsStarted;
    network["rssi"] = rssi;
    network["savedSsid"] = view.savedSsid;
    network["currentSsid"] = view.currentSsid;
    network["hint"] = networkHintKey(view.networkHint);
    network["hintText"] = networkHintText(view.networkHint);

    return serialize(doc);
  }

  // Builds the /config JSON response with capabilities and current settings.
  static String config(const RuntimeSettings& settings) {
    JsonDocument doc;
    doc["device"] = DEVICE_NAME;
    doc["version"] = FIRMWARE_VERSION;
    doc["ip"] = WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
    doc["mdnsName"] = MDNS_NAME;
    doc["sensorDistanceXmm"] = SENSOR_DISTANCE_X_MM;
    doc["sensorDistanceYmm"] = SENSOR_DISTANCE_Y_MM;
    doc["displayRotation"] = DISPLAY_ROTATION;
    doc["sensorCount"] = SENSOR_COUNT;
    doc["maxTargetTime"] = DEVICE_MAX_TARGET_TIME;
    doc["batteryVoltageEnabled"] = BATTERY_MONITOR_ENABLED;
    doc["batteryEmptyVoltage"] = BATTERY_EMPTY_VOLTAGE;
    doc["batteryFullVoltage"] = BATTERY_FULL_VOLTAGE;
    doc["sensorReadModel"] = "absolute_adc_threshold";
    JsonObject thresholds = doc["sensorThresholds"].to<JsonObject>();
    thresholds["lowOnRaw"] = SENSOR_ON_THRESHOLD_LOW;
    thresholds["lowOffRaw"] = SENSOR_OFF_THRESHOLD_LOW;
    thresholds["mediumOnRaw"] = SENSOR_ON_THRESHOLD_MEDIUM;
    thresholds["mediumOffRaw"] = SENSOR_OFF_THRESHOLD_MEDIUM;
    thresholds["highOnRaw"] = SENSOR_ON_THRESHOLD_HIGH;
    thresholds["highOffRaw"] = SENSOR_OFF_THRESHOLD_HIGH;

    // Capability arrays tell the WebUI which options this firmware supports.
    JsonArray seriesOptions = doc["targetSeriesOptions"].to<JsonArray>();
    seriesOptions.add("standard");
    seriesOptions.add("custom");

    JsonArray standard = doc["targetTimesStandard"].to<JsonArray>();
    for (int i = 0; i < TARGET_TIMES_STANDARD_COUNT; i++) standard.add(TARGET_TIMES_STANDARD[i]);

    JsonArray custom = doc["targetTimesCustom"].to<JsonArray>();
    for (int i = 0; i < settings.customTargetTimesCount && i < TARGET_TIMES_MAX_COUNT; i++) custom.add(settings.customTargetTimes[i]);

    JsonArray modes = doc["modes"].to<JsonArray>();
    modes.add("vertical");
    modes.add("horizontal");
    modes.add("central");

    JsonObject settingsObj = doc["settings"].to<JsonObject>();
    appendSettings(settingsObj, settings);

    doc["githubProjectUrl"] = GITHUB_PROJECT_URL;
    doc["webManifestUrl"] = WEB_MANIFEST_URL;
    doc["webAppDelivery"] = "manifest_proxy";
    return serialize(doc);
  }

  // Builds a compact error object shared by API handlers.
  static String error(const char* message, bool ok = false) {
    JsonDocument doc;
    doc["ok"] = ok;
    doc["error"] = message ? message : "error";
    return serialize(doc);
  }

  // Builds the POST /config response after settings have been sanitized.
  static String settingsResponse(const RuntimeSettings& settings, bool changed) {
    JsonDocument doc;
    doc["ok"] = true;
    doc["changed"] = changed;
    JsonObject obj = doc["settings"].to<JsonObject>();
    appendSettings(obj, settings);
    return serialize(doc);
  }

  // Builds the WiFi status JSON used by GET /wifi/status and POST /wifi.
  static String wifiStatus(const WifiStatusView& view) {
    JsonDocument doc;
    doc["ok"] = view.ok;
    doc["connected"] = view.connected;
    doc["apMode"] = view.apMode;
    doc["ip"] = view.ip;
    doc["apIp"] = view.apIp;
    doc["hostname"] = view.hostname.length() ? view.hostname : String(MDNS_NAME);
    doc["mdnsStarted"] = view.mdnsStarted;
    doc["hasSaved"] = view.hasSaved;
    doc["savedSsid"] = view.savedSsid;
    doc["currentSsid"] = view.currentSsid;
    doc["hint"] = networkHintKey(view.hint);
    doc["hintText"] = networkHintText(view.hint);
    doc["lastError"] = view.lastError;
    if (view.error && view.error[0]) doc["error"] = view.error;
    return serialize(doc);
  }

  // Builds the /data JSON response from the last raw measurement. Derived analysis remains WebUI-side.
  static String data(const MeasurementResult& result, uint32_t measurementId, const char* measurementIdString,
                     int targetFraction, MeasurementMode mode) {
    JsonDocument doc;
    doc["measCount"] = measurementId;
    doc["mode"] = measurementModeKey(mode);
    doc["target"] = targetFraction;
    doc["sensorDistanceXmm"] = SENSOR_DISTANCE_X_MM;
    doc["sensorDistanceYmm"] = SENSOR_DISTANCE_Y_MM;

    // No measurement id means the device has not produced any result since boot.
    if (!measurementIdString || measurementIdString[0] == '\0') {
      doc["valid"] = false;
      return serialize(doc);
    }

    doc["valid"] = result.valid;
    doc["id"] = measurementIdString;
    doc["baseUs"] = result.baseTimestamp;

    // The WebUI receives raw timestamps and ADC values; it performs exposure and curtain-speed calculations.
    JsonArray sensors = doc["sensors"].to<JsonArray>();
    for (int i = 0; i < SENSOR_COUNT; i++) {
      const SensorReading& s = result.sensors[i];
      JsonObject o = sensors.add<JsonObject>();
      o["id"] = i;
      o["activated"] = s.wasActivated;
      o["raw"] = s.rawValue;
      o["openUs"] = s.openTimestamp;
      o["closeUs"] = s.closeTimestamp;
    }

    const FlashReading& f = result.flash;
    JsonObject flash = doc["flash"].to<JsonObject>();
    flash["detected"] = f.detected;
    flash["raw"] = f.rawValue;
    flash["triggerUs"] = f.triggerTimestamp;

    return serialize(doc);
  }

  // Builds a live non-mutating sensor diagnostics snapshot for /sensors.
  static String sensors(const SensorManager& manager) {
    JsonDocument doc;
    doc["ok"] = true;
    doc["timeUs"] = esp_timer_get_time();
    doc["sensorCount"] = SENSOR_COUNT;
    doc["onThresholdRaw"] = manager.sensorOnThreshold();
    doc["offThresholdRaw"] = manager.sensorOffThreshold();

    JsonArray sensors = doc["sensors"].to<JsonArray>();
    for (int i = 0; i < SENSOR_COUNT; i++) {
      const SensorReading& tracked = manager.getSensor(i);
      const int raw = manager.readDiagnosticSensorRaw(i);
      JsonObject o = sensors.add<JsonObject>();
      o["id"] = i;
      o["pin"] = tracked.pin;
      o["raw"] = raw;
      o["onThresholdRaw"] = manager.sensorOnThreshold();
      o["offThresholdRaw"] = manager.sensorOffThreshold();
      o["active"] = manager.isDiagnosticSensorActive(i, raw);
      o["trackedActive"] = tracked.isActive;
      o["wasActivated"] = tracked.wasActivated;
      o["openUs"] = tracked.openTimestamp;
      o["closeUs"] = tracked.closeTimestamp;
    }

    const FlashReading& trackedFlash = manager.getFlash();
    const int flashRaw = manager.readDiagnosticFlashRaw();
    JsonObject flash = doc["flash"].to<JsonObject>();
    flash["pin"] = trackedFlash.pin;
    flash["raw"] = flashRaw;
    flash["active"] = manager.isDiagnosticFlashActive(flashRaw);
    flash["trackedActive"] = trackedFlash.isActive;
    flash["detected"] = trackedFlash.detected;
    flash["triggerUs"] = trackedFlash.triggerTimestamp;

    return serialize(doc);
  }

  // Appends the stored runtime settings object used by /config and POST /config responses.
  // Build-time capabilities such as maxTargetTime are reported at the top level, not inside settings.
  static void appendSettings(JsonObject obj, const RuntimeSettings& s) {
    obj["defaultMeasurementMode"] = measurementModeKey(s.defaultMode);
    obj["defaultTargetTime"] = s.defaultTargetTime;
    obj["sensorSensitivity"] = s.sensorSensitivity;
    obj["resultDisplay"] = s.resultDisplayMode;
    obj["targetSeries"] = targetSeriesKey(s.targetSeries);
    JsonArray custom = obj["customTargetTimes"].to<JsonArray>();
    for (int i = 0; i < s.customTargetTimesCount && i < TARGET_TIMES_MAX_COUNT; i++) custom.add(s.customTargetTimes[i]);
    obj["oledSleepMinutes"] = s.oledSleepMinutes;
  }

private:
  // Serializes a JSON document into an Arduino String and reports allocation overflows.
  template <typename TDoc>
  static String serialize(TDoc& doc) {
    String out;
    if (doc.overflowed()) {
      JsonDocument errorDoc;
      errorDoc["ok"] = false;
      errorDoc["error"] = "json_overflow";
      serializeJson(errorDoc, out);
      return out;
    }
    serializeJson(doc, out);
    return out;
  }
};
