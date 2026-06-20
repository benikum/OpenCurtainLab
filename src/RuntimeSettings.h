/*
 * Loads, validates, stores, and serializes user-configurable runtime settings.
 * Build-time device limits stay in Config.h and are exposed as capabilities, not saved settings.
 */

#pragma once
#include <Arduino.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "Config.h"
#include "MeasurementTypes.h"
#include "TargetTimes.h"

struct RuntimeSettings {
  MeasurementMode defaultMode = MeasurementMode::HORIZONTAL;
  int defaultTargetTime = DEFAULT_TARGET_TIME;
  String sensorSensitivity = DEFAULT_SENSOR_SENSITIVITY;
  String resultDisplayMode = DEFAULT_RESULT_DISPLAY;
  TargetSeries targetSeries = TargetSeries::Standard;
  int customTargetTimes[TARGET_TIMES_MAX_COUNT] = { 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000 };
  int customTargetTimesCount = TARGET_TIMES_CUSTOM_DEFAULT_COUNT;
  int oledSleepMinutes = DEFAULT_OLED_SLEEP_MINUTES;

  // Returns the ADC activation threshold for the selected sensitivity.
  int sensorOnDelta() const {
    if (sensorSensitivity == "low") return SENSOR_ON_DELTA_LOW;
    if (sensorSensitivity == "high") return SENSOR_ON_DELTA_HIGH;
    return SENSOR_ON_DELTA_MEDIUM;
  }

  // Returns the ADC release threshold for the selected sensitivity.
  int sensorOffDelta() const {
    if (sensorSensitivity == "low") return SENSOR_OFF_DELTA_LOW;
    if (sensorSensitivity == "high") return SENSOR_OFF_DELTA_HIGH;
    return SENSOR_OFF_DELTA_MEDIUM;
  }
};

// Maps the result display mode to a timeout in milliseconds.
static inline unsigned long resultDisplayDurationMs(const String& mode) {
  if (mode == "2s") return 2000UL;
  if (mode == "5s") return 5000UL;
  if (mode == "10s") return 10000UL;
  return 0UL;
}

// Maps the result display mode to a short menu label.
static inline const char* resultDisplayLabel(const String& mode) {
  if (mode == "2s") return "2 s";
  if (mode == "5s") return "5 s";
  if (mode == "10s") return "10 s";
  if (mode == "none") return "Off";
  return "Button";
}

// Cycles to the next result display mode used by the local menu.
static inline String nextResultDisplayMode(const String& mode) {
  if (mode == "until_button") return "2s";
  if (mode == "2s") return "5s";
  if (mode == "5s") return "10s";
  if (mode == "10s") return "none";
  return "until_button";
}

class RuntimeSettingsStore {
public:
  // Loads persisted settings from non-volatile storage.
  void begin() { load(); }

  // Returns the current sanitized settings.
  const RuntimeSettings& get() const { return _s; }

  // Loads settings from Preferences and sanitizes them.
  void load() {
    Preferences p;
    p.begin("settings", true);
    _s.defaultMode = measurementModeFromKey(p.getString("mode", DEFAULT_MEASUREMENT_MODE));
    _s.defaultTargetTime = p.getInt("defTarget", DEFAULT_TARGET_TIME);
    _s.sensorSensitivity = p.getString("sens", DEFAULT_SENSOR_SENSITIVITY);
    _s.resultDisplayMode = p.getString("resDisp", DEFAULT_RESULT_DISPLAY);
    _s.targetSeries = targetSeriesFromKey(p.getString("tSeries", "standard"));
    _s.customTargetTimesCount = p.getInt("custCount", TARGET_TIMES_CUSTOM_DEFAULT_COUNT);
    if (_s.customTargetTimesCount < 1 || _s.customTargetTimesCount > TARGET_TIMES_MAX_COUNT) {
      _s.customTargetTimesCount = TARGET_TIMES_CUSTOM_DEFAULT_COUNT;
    }
    for (int i = 0; i < _s.customTargetTimesCount; i++) {
      char key[12];
      snprintf(key, sizeof(key), "cust%02d", i);
      _s.customTargetTimes[i] = p.getInt(key, i < TARGET_TIMES_CUSTOM_DEFAULT_COUNT ? TARGET_TIMES_CUSTOM_DEFAULT[i] : 0);
    }
    _s.oledSleepMinutes = p.getInt("oledSleep", DEFAULT_OLED_SLEEP_MINUTES);
    p.end();
    sanitize();
  }

  // Persists the current sanitized settings to Preferences.
  void save() const {
    Preferences p;
    p.begin("settings", false);
    p.putString("mode", measurementModeKey(_s.defaultMode));
    p.putInt("defTarget", _s.defaultTargetTime);
    p.putString("sens", _s.sensorSensitivity);
    p.putString("resDisp", _s.resultDisplayMode);
    p.putString("tSeries", targetSeriesKey(_s.targetSeries));
    p.putInt("custCount", _s.customTargetTimesCount);
    for (int i = 0; i < _s.customTargetTimesCount && i < TARGET_TIMES_MAX_COUNT; i++) {
      char key[12];
      snprintf(key, sizeof(key), "cust%02d", i);
      p.putInt(key, _s.customTargetTimes[i]);
    }
    p.putInt("oledSleep", _s.oledSleepMinutes);
    p.end();
  }

  // Applies a partial /config JSON update and persists it when changed.
  bool applyJson(const String& body) {
    StaticJsonDocument<1024> doc;
    DeserializationError err = deserializeJson(doc, body);
    if (err) return false;

    bool changed = false;

    if (doc.containsKey("defaultMeasurementMode")) {
      _s.defaultMode = measurementModeFromKey(String(doc["defaultMeasurementMode"] | ""));
      changed = true;
    }

    // maxTargetTime is a build-time device capability and is intentionally ignored if posted.
    if (doc.containsKey("defaultTargetTime")) { _s.defaultTargetTime = doc["defaultTargetTime"].as<int>(); changed = true; }

    if (doc.containsKey("resultDisplay")) { _s.resultDisplayMode = String(doc["resultDisplay"] | DEFAULT_RESULT_DISPLAY); changed = true; }
    if (doc.containsKey("targetSeries")) {
      _s.targetSeries = targetSeriesFromKey(String(doc["targetSeries"] | ""));
      changed = true;
    }

    // Custom times are accepted as unsorted raw input; sanitize() applies limits, de-duplication, and sorting.
    if (doc.containsKey("customTargetTimes") && doc["customTargetTimes"].is<JsonArray>()) {
      JsonArray arr = doc["customTargetTimes"].as<JsonArray>();
      int n = 0;
      for (JsonVariant v : arr) {
        if (n >= TARGET_TIMES_MAX_COUNT) break;
        const int val = v.as<int>();
        if (val > 0) _s.customTargetTimes[n++] = val;
      }
      if (n > 0) _s.customTargetTimesCount = n;
      changed = true;
    }

    if (doc.containsKey("oledSleepMinutes")) { _s.oledSleepMinutes = doc["oledSleepMinutes"].as<int>(); changed = true; }

    if (doc.containsKey("sensorSensitivity")) {
      _s.sensorSensitivity = String(doc["sensorSensitivity"] | "");
      changed = true;
    }

    if (changed) { sanitize(); save(); }
    return changed;
  }

  // Serializes the current settings as a compact JSON object.
  String settingsJson() const {
    StaticJsonDocument<1024> doc;
    doc["defaultMeasurementMode"] = measurementModeKey(_s.defaultMode);
    doc["defaultTargetTime"] = _s.defaultTargetTime;
    doc["sensorSensitivity"] = _s.sensorSensitivity;
    doc["resultDisplay"] = _s.resultDisplayMode;
    doc["targetSeries"] = targetSeriesKey(_s.targetSeries);
    JsonArray custom = doc.createNestedArray("customTargetTimes");
    for (int i = 0; i < _s.customTargetTimesCount && i < TARGET_TIMES_MAX_COUNT; i++) custom.add(_s.customTargetTimes[i]);
    doc["oledSleepMinutes"] = _s.oledSleepMinutes;

    String out;
    serializeJson(doc, out);
    return out;
  }

  // Extracts a string value from a JSON object helper payload.
  static String extractJsonString(const String& json, const char* key) {
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, json)) return "";
    if (!doc.containsKey(key)) return "";
    return String(doc[key] | "");
  }

  // Extracts an integer value from a JSON object helper payload.
  static bool extractJsonInt(const String& json, const char* key, int& out) {
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, json)) return false;
    if (!doc.containsKey(key)) return false;
    out = doc[key].as<int>();
    return true;
  }

  // Extracts a boolean value from a JSON object helper payload.
  static bool extractJsonBool(const String& json, const char* key, bool& out) {
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, json)) return false;
    if (!doc.containsKey(key)) return false;
    out = doc[key].as<bool>();
    return true;
  }

private:
  RuntimeSettings _s;

  // Normalizes settings and mirrors sanitized custom times into global target lists.
  void sanitize() {
    setCustomTargetTimes(_s.customTargetTimes, _s.customTargetTimesCount, DEVICE_MAX_TARGET_TIME);
    _s.customTargetTimesCount = targetTimesCountForSeries(TargetSeries::Custom);
    const int* customTimes = targetTimesForSeries(TargetSeries::Custom);
    for (int i = 0; i < _s.customTargetTimesCount; i++) _s.customTargetTimes[i] = customTimes[i];

    const int* times = targetTimesForSeries(_s.targetSeries);
    const int count = targetTimesCountForSeries(_s.targetSeries);
    if (count <= 0) return;

    if (_s.defaultTargetTime < times[0]) _s.defaultTargetTime = times[0];
    if (_s.defaultTargetTime > times[count - 1]) _s.defaultTargetTime = times[count - 1];
    if (_s.sensorSensitivity != "low" &&
        _s.sensorSensitivity != "medium" && _s.sensorSensitivity != "high") {
      _s.sensorSensitivity = DEFAULT_SENSOR_SENSITIVITY;
    }

    if (_s.resultDisplayMode != "until_button" && _s.resultDisplayMode != "2s" &&
        _s.resultDisplayMode != "5s" && _s.resultDisplayMode != "10s" &&
        _s.resultDisplayMode != "none") {
      _s.resultDisplayMode = DEFAULT_RESULT_DISPLAY;
    }

    const int allowedSleep[] = {0, 1, 5, 10, 30};
    bool sleepOk = false;
    for (int i = 0; i < 5; i++) if (_s.oledSleepMinutes == allowedSleep[i]) sleepOk = true;
    if (!sleepOk) _s.oledSleepMinutes = DEFAULT_OLED_SLEEP_MINUTES;
  }
};
