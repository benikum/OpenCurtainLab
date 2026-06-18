/*
 * Reads the five phototransistors and the flash contact, tracks edges, and maintains sensor baselines.
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
  SensorManager() : _sensorOnDelta(SENSOR_ON_DELTA_MEDIUM), _sensorOffDelta(SENSOR_OFF_DELTA_MEDIUM) {
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
    }
    pinMode(_flash.pin, INPUT_PULLUP);
    Serial.println(F("[Sensor] Inputs initialized."));
  }

  // Stores ADC hysteresis thresholds for light detection.
  void setSensorThresholds(int onDelta, int offDelta) {
    _sensorOnDelta = max(1, onDelta);
    _sensorOffDelta = max(1, offDelta);
    if (_sensorOffDelta >= _sensorOnDelta) _sensorOffDelta = max(1, _sensorOnDelta / 2);
    Serial.printf("[Sensor] ADC thresholds: on=%d off=%d\n", _sensorOnDelta, _sensorOffDelta);
  }

  // Samples each sensor baseline and reports whether all ADC baselines are usable.
  bool calibrateBaseline() {
    resetTracking();

    const int samples = max(1, (int)SENSOR_BASELINE_SAMPLES);
    const unsigned long stepMs = (samples > 1) ? SENSOR_BASELINE_DURATION_MS / (samples - 1) : 0;
    int32_t sums[SENSOR_COUNT] = {0};

    for (int sample = 0; sample < samples; sample++) {
      for (int i = 0; i < SENSOR_COUNT; i++) {
        const int val = readStableAdc(_sensors[i].pin);
        _sensors[i].rawValue = val;
        sums[i] += val;
      }
      if (sample < samples - 1 && stepMs > 0) delay(stepMs);
    }

    bool ok = true;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      _sensors[i].baselineValue = (int)roundf((float)sums[i] / samples);
      _sensors[i].isActive = false;
      ok &= (_sensors[i].baselineValue >= SENSOR_BASELINE_MIN_RAW);
      Serial.printf("[Sensor] S%d baseline=%d raw=%d\n", i, _sensors[i].baselineValue, _sensors[i].rawValue);
    }

    _flash.rawValue = digitalRead(_flash.pin);
    _flash.baselineValue = _flash.rawValue;
    _flash.isActive = isFlashActive(_flash.rawValue);
    Serial.printf("[Sensor] Flash raw=%d active=%d\n", _flash.rawValue, _flash.isActive);
    return ok;
  }

  // Scans all sensors and the flash input once using one shared timestamp.
  bool update() {
    // One timestamp per full sensor scan keeps the polling loop lean and
    // makes all edges detected in the same scan comparable.
    const int64_t scanTimestampUs = esp_timer_get_time();

    bool changed = false;
    for (int i = 0; i < SENSOR_COUNT; i++) changed |= updateSensor(_sensors[i], scanTimestampUs);
    changed |= updateFlashInput(scanTimestampUs);
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
    const int baseline = _sensors[idx].baselineValue;
    return baseline > 0 && raw <= (baseline - _sensorOnDelta);
  }

  // Reads the flash contact for diagnostics without touching trigger tracking.
  int readDiagnosticFlashRaw() const { return digitalRead(_flash.pin); }

  // Computes whether a diagnostic flash-contact sample is active.
  bool isDiagnosticFlashActive(int raw) const { return isFlashActive(raw); }

  // Returns the current hysteresis thresholds for diagnostics.
  int sensorOnDelta() const { return _sensorOnDelta; }
  int sensorOffDelta() const { return _sensorOffDelta; }

  // Returns true if any sensor is currently active.
  bool isAnySensorActive() const {
    for (int i = 0; i < SENSOR_COUNT; i++) if (_sensors[i].isActive) return true;
    return false;
  }

  // Returns true if an inactive-before sensor is currently active during settling.
  bool isAnyUnusedSensorActive() const {
    for (int i = 0; i < SENSOR_COUNT; i++) if (!_sensors[i].wasActivated && _sensors[i].isActive) return true;
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
  int _sensorOnDelta;
  int _sensorOffDelta;

  // Updates one phototransistor reading and records open/close edges.
  bool updateSensor(SensorReading& s, int64_t timestampUs) {
    // Finished sensors no longer need ADC reads during the same measurement.
    // This increases the scan rate as soon as early sensors have closed.
    if (s.wasActivated && !s.isActive && s.closeTimestamp > 0) return false;

    const int val = readFastSensor(s.pin);
    s.rawValue = val;
    if (s.baselineValue <= 0) s.baselineValue = val;

    bool nextActive = s.isActive;
    if (!s.isActive && val <= (s.baselineValue - _sensorOnDelta)) nextActive = true;
    if (s.isActive && val >= (s.baselineValue - _sensorOffDelta)) nextActive = false;

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

  // Reads one ADC pin three times and returns the median value.
  static int readStableAdc(uint8_t pin) {
    const int a = analogRead(pin);
    const int b = analogRead(pin);
    const int c = analogRead(pin);
    return max(min(a, b), min(max(a, b), c));
  }
};
