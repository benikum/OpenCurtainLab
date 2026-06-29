/*
 * Runs the time-critical shutter capture state machine and produces raw measurement data plus OLED summaries.
 */

#pragma once
#include <Arduino.h>
#include "Config.h"
#include "SensorManager.h"
#include "MeasurementTypes.h"

enum class CaptureState : uint8_t {
  IDLE,
  ARMED,
  CAPTURING,
  FINISHED
};

class MeasurementEngine {
public:
  // Stores the sensor manager reference and clears all measurement buffers.
  explicit MeasurementEngine(SensorManager& sm)
    : _sm(sm), _state(CaptureState::IDLE), _mode(MeasurementMode::HORIZONTAL) {
    _result.reset();
    _summary.reset();
  }

  // Advances the capture state machine.
  void update() {
    if (_state != CaptureState::ARMED && _state != CaptureState::CAPTURING) return;

    const bool inputChanged = _sm.update();
    if (_state == CaptureState::CAPTURING && inputChanged) _lastCaptureActivityMs = millis();

    switch (_state) {
      case CaptureState::ARMED:     handleArmed(); break;
      case CaptureState::CAPTURING: handleCapturing(); break;
      default: break;
    }
  }

  // Arms the engine for a new capture if the sensors are currently idle.
  bool startListening(MeasurementMode mode = MeasurementMode::HORIZONTAL) {
    if (_state == CaptureState::CAPTURING) return false;

    // Start from a clean result and summary so stale data cannot leak into the next capture.
    _mode = mode;
    _result.reset();
    _summary.reset();
    _result.mode = _mode;
    _resultCalculated = false;
    _hasNewResult = false;
    _finishCandidateMs = 0;
    _lastCaptureActivityMs = 0;
    _flashSeenMs = 0;

    // A fresh scan detects blocked sensors before the engine is allowed to arm.
    _sm.resetTracking();
    _sm.update();
    if (_sm.isAnySensorActive()) {
      abortStart("sensor input active");
      return false;
    }
    if (_sm.getFlash().isActive) {
      abortStart("flash input active");
      return false;
    }

    enterState(CaptureState::ARMED);
    Serial.println(F("[Engine] Armed - waiting for shutter opening..."));
    return true;
  }

  // Computes OLED-only summary values from the raw measurement result and keeps minimal validity metadata current.
  void calculateResults(int targetFraction) {
    if (_resultCalculated) return;
    if (targetFraction <= 0) return;
    _resultCalculated = true;

    _summary.reset();

    const float targetSeconds = 1.0f / targetFraction;
    float sumSeconds = 0.0f;
    float minSeconds = 1e9f;
    float maxSeconds = 0.0f;
    int count = 0;

    // Only sensors with complete open/close timestamps contribute to the OLED summary.
    for (int i = 0; i < SENSOR_COUNT; i++) {
      const SensorReading& s = _result.sensors[i];
      if (!s.wasActivated) continue;
      if (s.openTimestamp <= 0 || s.closeTimestamp <= s.openTimestamp) continue;

      const float duration = (s.closeTimestamp - s.openTimestamp) / 1000000.0f;
      SensorDisplaySummary& ds = _summary.sensors[i];
      ds.measuredSeconds = duration;
      ds.measuredFraction = duration > 0 ? (int)roundf(1.0f / duration) : 0;
      ds.deviationStops = (duration > 0 && targetSeconds > 0) ? log2f(duration / targetSeconds) : 0.0f;

      sumSeconds += duration;
      minSeconds = min(minSeconds, duration);
      maxSeconds = max(maxSeconds, duration);
      count++;
    }

    _result.valid = count > 0;
    _result.activatedCount = count;
    _summary.valid = count > 0;
    _summary.activatedCount = count;

    if (count > 0) {
      _summary.avgSeconds = sumSeconds / count;
      _summary.avgFraction = (int)roundf(1.0f / _summary.avgSeconds);
      _summary.avgDeviationStops = log2f(_summary.avgSeconds / targetSeconds);
      _summary.spreadStops = (count > 1 && minSeconds > 0) ? log2f(maxSeconds / minSeconds) : 0.0f;
    }

    Serial.printf("[Engine] Measurement complete: %d sensors, flash %s\n", count, _result.flash.detected ? "detected" : "not detected");
  }

  // Returns the internal capture state.
  CaptureState getState() const { return _state; }
  // Returns true while the engine waits for the first shutter sensor edge.
  bool isArmed() const { return _state == CaptureState::ARMED; }
  // Returns true while the shutter event is being captured.
  bool isCapturing() const { return _state == CaptureState::CAPTURING; }
  // Returns true after a capture has finished.
  bool isFinished() const { return _state == CaptureState::FINISHED; }
  // Returns true until the app has consumed the latest result.
  bool hasNewResult() const { return _hasNewResult; }
  // Marks the latest result as consumed by the app.
  void markResultHandled() { _hasNewResult = false; }

  // Returns the current measurement mode.
  MeasurementMode getMode() const { return _mode; }
  // Stores the measurement mode used for the next result.
  void setMode(MeasurementMode mode) { _mode = mode; _result.mode = mode; }
  // Returns a mutable reference to the raw result buffer.
  MeasurementResult& getResult() { return _result; }
  // Returns the raw result buffer.
  const MeasurementResult& getResult() const { return _result; }
  // Returns the OLED-only calculated result summary.
  const DisplayResultSummary& getSummary() const { return _summary; }

  // Stops any active capture and returns the engine to idle.
  void cancel() {
    _resultCalculated = false;
    _hasNewResult = false;
    _summary.reset();
    _sm.resetTracking();
    _finishCandidateMs = 0;
    _lastCaptureActivityMs = 0;
    _flashSeenMs = 0;
    enterState(CaptureState::IDLE);
    Serial.println(F("[Engine] Capture cancelled."));
  }

private:
  SensorManager& _sm;
  CaptureState _state = CaptureState::IDLE;
  MeasurementMode _mode = MeasurementMode::HORIZONTAL;
  MeasurementResult _result;
  DisplayResultSummary _summary;
  bool _resultCalculated = false;
  bool _hasNewResult = false;
  unsigned long _stateStartedMs = 0;
  unsigned long _finishCandidateMs = 0;
  unsigned long _lastCaptureActivityMs = 0;
  unsigned long _flashSeenMs = 0;

  // Changes the internal capture state and records when it started.
  void enterState(CaptureState next) {
    _state = next;
    _stateStartedMs = millis();
  }

  // Aborts arming because the current conditions are unsuitable for capture.
  void abortStart(const char* reason) {
    _lastCaptureActivityMs = 0;
    _sm.resetTracking();
    enterState(CaptureState::IDLE);
    Serial.printf("[Engine] Start aborted: %s\n", reason && reason[0] ? reason : "input not idle");
  }

  // Returns true when the active capture exceeded the maximum duration.
  bool hasTimedOut() const {
    return (millis() - _stateStartedMs) >= MEASUREMENT_TIMEOUT_MS;
  }

  // Returns how long the input must stay quiet before a finished shutter event is accepted.
  unsigned long finishSettleMs() const {
    return _mode == MeasurementMode::CENTRAL ? MEASUREMENT_SETTLE_MS : MEASUREMENT_LATE_SENSOR_SETTLE_MS;
  }

  // Copies the current sensor and flash snapshot into the raw result buffer.
  void copySnapshotToResult() {
    for (int i = 0; i < SENSOR_COUNT; i++) _result.sensors[i] = _sm.getSensor(i);
    _result.flash = _sm.getFlash();
    _result.mode = _mode;
    _result.activatedCount = _sm.countActivated();
    _result.valid = _result.activatedCount > 0;
    updateBaseTimestamp();
  }

  // Sets the result base timestamp to the first flash or sensor event.
  void updateBaseTimestamp() {
    if (_result.baseTimestamp > 0) return;
    int64_t first = 0;
    if (_result.flash.detected && _result.flash.triggerTimestamp > 0) first = _result.flash.triggerTimestamp;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      const SensorReading& s = _result.sensors[i];
      if (s.wasActivated && s.openTimestamp > 0 && (first == 0 || s.openTimestamp < first)) first = s.openTimestamp;
    }
    _result.baseTimestamp = first;
  }

  // Handles the armed state while waiting for the first sensor activation.
  void handleArmed() {
    // Flash can arrive slightly before the first shutter sensor edge, so wait briefly before ignoring flash-only noise.
    if (_sm.getFlash().triggeredThisUpdate && _sm.countActivated() == 0 && _flashSeenMs == 0) {
      _flashSeenMs = millis();
      Serial.println(F("[Engine] Flash contact detected - waiting briefly for first shutter sensor..."));
    }

    if (_sm.countActivated() > 0) {
      enterState(CaptureState::CAPTURING);
      _lastCaptureActivityMs = millis();
      _flashSeenMs = 0;
      Serial.println(F("[Engine] First sensor activation detected."));
      return;
    }

    if (_flashSeenMs > 0 && (millis() - _flashSeenMs) >= FLASH_TO_SENSOR_TIMEOUT_MS) ignoreFlashWithoutSensors();
  }

  // Handles the capture state until sensors close, the input stays quiet, or the capture times out.
  void handleCapturing() {
    if (hasTimedOut()) {
      timeoutToFinished();
      return;
    }

    // End only after all activated sensors closed and the input has stayed quiet long enough.
    if (_sm.countActivated() > 0 && _sm.wereAllActivatedSensorsClosed()) {
      const unsigned long nowMs = millis();
      if (_finishCandidateMs == 0) _finishCandidateMs = nowMs;

      // Use the last detected input change instead of the first closed-all moment so slow curtain travel
      // can still activate later sensors before the capture is finalized.
      const unsigned long referenceMs = _lastCaptureActivityMs > 0 ? _lastCaptureActivityMs : _finishCandidateMs;
      if ((nowMs - referenceMs) >= finishSettleMs()) finishMeasurement();
    } else {
      _finishCandidateMs = 0;
    }
  }

  // Finalizes a capture and exposes exactly one new result to the app.
  void enterFinished() {
    if (_state == CaptureState::FINISHED && _hasNewResult) return;

    _resultCalculated = false;
    copySnapshotToResult();
    _finishCandidateMs = 0;
    _lastCaptureActivityMs = 0;
    _flashSeenMs = 0;
    _hasNewResult = true;
    enterState(CaptureState::FINISHED);
  }

  // Finishes a normal measurement.
  void finishMeasurement() {
    enterFinished();
  }

  // Ignores a flash-only event. It does not create a result and leaves the engine armed for a shutter event.
  void ignoreFlashWithoutSensors() {
    _sm.resetTracking();
    _flashSeenMs = 0;
    Serial.println(F("[Engine] Flash contact ignored because no shutter sensor followed."));
  }

  // Finishes a timeout measurement using the raw data available so far.
  void timeoutToFinished() {
    _sm.forceCloseActiveSensors(esp_timer_get_time());
    enterFinished();
    Serial.println(F("[Engine] Timeout: measurement finished with available raw data."));
  }
};
