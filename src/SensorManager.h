/*
 * Reads the five phototransistors and the flash contact, tracks edges, and exposes live diagnostics.
 */

#pragma once
#include <Arduino.h>
#include "Config.h"
#include "MeasurementTypes.h"

// Hardware-facing capture notes:
// - Phototransistors pull ADC pins downward when light reaches the sensor.
// - The flash contact is active LOW through the configured pull-up input.
class SensorManager {
public:
  // Assigns the five sensor pins and initializes the flash input state.
  SensorManager() : _sensorOnThreshold(SENSOR_ON_THRESHOLD_MEDIUM), _sensorOffThreshold(SENSOR_OFF_THRESHOLD_MEDIUM) {
    const uint8_t pins[] = { PIN_SENSOR_0, PIN_SENSOR_1, PIN_SENSOR_2, PIN_SENSOR_3, PIN_SENSOR_4 };
    for (int i = 0; i < SENSOR_COUNT; i++) {
      _sensors[i].id = i;
      _sensors[i].pin = pins[i];
    }
    _flash.reset();
  }

  // Configures ADC resolution, sensor pins, attenuation, and flash input pull-up.
  void begin() {
    analogReadResolution(12);
    for (int i = 0; i < SENSOR_COUNT; i++) {
      pinMode(_sensors[i].pin, INPUT);
      analogSetPinAttenuation(_sensors[i].pin, ADC_11db);
      _sensors[i].rawValue = 4095;
    }
    pinMode(_flash.pin, INPUT_PULLUP);
    Serial.println(F("[Sensor] Inputs initialized. Dark idle raw is expected near 4095."));
  }

  // Stores absolute ADC hysteresis thresholds for light detection.
  void setSensorThresholds(int onThreshold, int offThreshold) {
    _sensorOnThreshold = constrain(onThreshold, 0, 4095);
    _sensorOffThreshold = constrain(offThreshold, 0, 4095);
    if (_sensorOffThreshold <= _sensorOnThreshold) {
      _sensorOffThreshold = min(4095, _sensorOnThreshold + 100);
    }
    Serial.printf("[Sensor] ADC thresholds: on<=%d off>=%d\n", _sensorOnThreshold, _sensorOffThreshold);
  }

  // Scans unfinished sensors and the flash input once; each sampled ADC channel receives its own timestamp.
  bool update() {
    bool changed = false;
    for (int i = 0; i < SENSOR_COUNT; i++) changed |= updateSensor(_sensors[i]);
    changed |= updateFlashInput(esp_timer_get_time());
    return changed;
  }

  // Updates the flash input using the current timer value.
  bool updateFlashInput() {
    return updateFlashInput(esp_timer_get_time());
  }

  // Updates flash contact state and records the first trigger edge.
  bool updateFlashInput(int64_t timestampUs) {
    _flash.triggeredThisUpdate = false;

    const int val = digitalRead(_flash.pin);
    const bool wasActive = _flash.isActive;
    const bool activeNow = isFlashActive(val);

    _flash.rawValue = val;
    _flash.isActive = activeNow;

    if (!wasActive && activeNow) {
      _flash.triggeredThisUpdate = true;
      if (!_flash.detected) {
        _flash.detected = true;
        _flash.triggerTimestamp = timestampUs;
      }
    }
    return (activeNow != wasActive) || _flash.triggeredThisUpdate;
  }

  // Clears all per-measurement tracking flags for sensors and flash.
  void resetTracking() {
    for (int i = 0; i < SENSOR_COUNT; i++) _sensors[i].resetMeasurement();
    _flash.resetMeasurement();
  }

  // Returns a sensor reading by clamped index.
  SensorReading& getSensor(int idx) {
    if (idx < 0) idx = 0;
    if (idx >= SENSOR_COUNT) idx = SENSOR_COUNT - 1;
    return _sensors[idx];
  }

  // Returns a const sensor reading by clamped index.
  const SensorReading& getSensor(int idx) const {
    if (idx < 0) idx = 0;
    if (idx >= SENSOR_COUNT) idx = SENSOR_COUNT - 1;
    return _sensors[idx];
  }

  // Returns the full sensor reading array.
  const SensorReading* getSensors() const { return _sensors; }
  // Returns the mutable flash reading.
  FlashReading& getFlash() { return _flash; }
  // Returns the flash reading.
  const FlashReading& getFlash() const { return _flash; }

  // Reads a phototransistor for diagnostics without touching measurement edge tracking.
  int readDiagnosticSensorRaw(int idx) const {
    if (idx < 0) idx = 0;
    if (idx >= SENSOR_COUNT) idx = SENSOR_COUNT - 1;
    return readFastSensor(_sensors[idx].pin);
  }

  // Computes whether a diagnostic ADC sample would currently count as active.
  bool isDiagnosticSensorActive(int idx, int raw) const {
    if (idx < 0) idx = 0;
    if (idx >= SENSOR_COUNT) idx = SENSOR_COUNT - 1;
    return raw <= _sensorOnThreshold;
  }

  // Reads the flash contact for diagnostics without touching trigger tracking.
  int readDiagnosticFlashRaw() const { return digitalRead(_flash.pin); }

  // Computes whether a diagnostic flash-contact sample is active.
  bool isDiagnosticFlashActive(int raw) const { return isFlashActive(raw); }

  // Returns the current absolute ADC thresholds for diagnostics.
  int sensorOnThreshold() const { return _sensorOnThreshold; }
  int sensorOffThreshold() const { return _sensorOffThreshold; }


  // Returns true if any sensor is currently active.
  bool isAnySensorActive() const {
    for (int i = 0; i < SENSOR_COUNT; i++) if (_sensors[i].isActive) return true;
    return false;
  }

  // Returns true once every activated sensor is inactive again.
  bool wereAllActivatedSensorsClosed() const {
    for (int i = 0; i < SENSOR_COUNT; i++) if (_sensors[i].wasActivated && _sensors[i].isActive) return false;
    return true;
  }

  // Counts sensors that have opened at least once in the current measurement.
  int countActivated() const {
    int count = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) if (_sensors[i].wasActivated) count++;
    return count;
  }

  // Closes still-active sensors synthetically when a timeout ends the measurement.
  void forceCloseActiveSensors(int64_t timestampUs) {
    for (int i = 0; i < SENSOR_COUNT; i++) {
      SensorReading& s = _sensors[i];
      if (s.wasActivated && s.isActive && s.closeTimestamp == 0) {
        s.isActive = false;
        s.closeTimestamp = timestampUs;
        s.lastEdgeTimestamp = timestampUs;
      }
    }
  }

private:
  SensorReading _sensors[SENSOR_COUNT];
  FlashReading _flash;
  int _sensorOnThreshold;
  int _sensorOffThreshold;

  // Updates one phototransistor reading and records open/close edges.
  bool updateSensor(SensorReading& s) {
    if (s.wasActivated && !s.isActive && s.closeTimestamp > 0) return false;

    const int val = readFastSensor(s.pin);
    const int64_t timestampUs = esp_timer_get_time();
    s.rawValue = val;

    bool nextActive = s.isActive;
    if (!s.isActive && val <= _sensorOnThreshold) nextActive = true;
    if (s.isActive && val >= _sensorOffThreshold) nextActive = false;

    if (nextActive == s.isActive) return false;

    s.isActive = nextActive;
    s.lastEdgeTimestamp = timestampUs;

    if (nextActive) {
      if (!s.wasActivated) {
        s.wasActivated = true;
        s.openTimestamp = timestampUs;
      }
    } else if (s.wasActivated && s.closeTimestamp == 0) {
      s.closeTimestamp = timestampUs;
    }
    return true;
  }

  // Converts a raw flash contact level to active/inactive.
  static bool isFlashActive(int raw) { return raw == LOW; }

  // Reads one phototransistor ADC pin as quickly as practical.
  static int readFastSensor(uint8_t pin) {
    return analogRead(pin);
  }
};
