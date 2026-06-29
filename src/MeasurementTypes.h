/*
 * Defines measurement modes, raw sensor readings, flash readings, device status, network hints, and result summary structs.
 */

#pragma once
#include <Arduino.h>
#include "Config.h"

enum class MeasurementMode : uint8_t {
  VERTICAL = 0,
  HORIZONTAL = 1,
  CENTRAL = 2
};

// Converts a measurement mode enum value to its stable API/settings key.
static inline const char* measurementModeKey(MeasurementMode mode) {
  switch (mode) {
    case MeasurementMode::VERTICAL:   return "vertical";
    case MeasurementMode::HORIZONTAL: return "horizontal";
    case MeasurementMode::CENTRAL:    return "central";
  }
  return "horizontal";
}

// Parses a stable mode key. Unknown keys fall back to the default horizontal geometry.
static inline MeasurementMode measurementModeFromKey(const String& key) {
  return key == "vertical" ? MeasurementMode::VERTICAL
       : key == "central" ? MeasurementMode::CENTRAL
       : MeasurementMode::HORIZONTAL;
}

// Returns the next mode in the local button cycle.
static inline MeasurementMode nextMeasurementMode(MeasurementMode mode) {
  return static_cast<MeasurementMode>((static_cast<uint8_t>(mode) + 1) % 3);
}

struct SensorReading {
  uint8_t id = 0;
  uint8_t pin = 0;

  int rawValue = 4095;

  bool isActive = false;
  bool wasActivated = false;

  int64_t openTimestamp = 0;
  int64_t closeTimestamp = 0;
  int64_t lastEdgeTimestamp = 0;

  // Clears per-measurement sensor edge state while keeping pin and latest raw data.
  void resetMeasurement() {
    isActive = false;
    wasActivated = false;
    openTimestamp = 0;
    closeTimestamp = 0;
    lastEdgeTimestamp = 0;
  }

  // Resets the sensor structure while preserving its id and pin assignment.
  void reset() {
    const uint8_t oldId = id;
    const uint8_t oldPin = pin;
    *this = SensorReading();
    id = oldId;
    pin = oldPin;
  }
};

struct FlashReading {
  uint8_t pin = PIN_FLASH_SENSOR;
  int rawValue = HIGH;

  bool isActive = false;
  bool detected = false;
  bool triggeredThisUpdate = false;

  int64_t triggerTimestamp = 0;

  // Clears per-measurement flash trigger state while keeping pin and latest raw data.
  void resetMeasurement() {
    detected = false;
    triggeredThisUpdate = false;
    triggerTimestamp = 0;
  }

  // Resets the flash structure to its idle electrical state.
  void reset() {
    pin = PIN_FLASH_SENSOR;
    rawValue = HIGH;
    isActive = false;
    resetMeasurement();
  }
};

enum class DeviceSubsystem : uint8_t {
  None,
  Sensor,
  Network,
  Storage,
  Display
};

// Converts a device subsystem to its API key.
static inline const char* deviceSubsystemKey(DeviceSubsystem subsystem) {
  switch (subsystem) {
    case DeviceSubsystem::None: return "none";
    case DeviceSubsystem::Sensor: return "sensor";
    case DeviceSubsystem::Network: return "network";
    case DeviceSubsystem::Storage: return "storage";
    case DeviceSubsystem::Display: return "display";
  }
  return "unknown";
}

enum class DeviceError : uint8_t {
  None,
  NetworkAccessPointFailed,
  DisplayInitFailed
};

struct DeviceStatus {
  DeviceError error = DeviceError::None;
  DeviceSubsystem subsystem = DeviceSubsystem::None;

  // Returns whether the status contains a device-level error.
  bool hasError() const { return error != DeviceError::None; }
};

// Converts a device-level error to its API key.
static inline const char* deviceErrorKey(DeviceError error) {
  switch (error) {
    case DeviceError::None: return "none";
    case DeviceError::NetworkAccessPointFailed: return "network_access_point_failed";
    case DeviceError::DisplayInitFailed: return "display_init_failed";
  }
  return "unknown";
}

// Converts a device-level error to display text.
static inline const char* deviceErrorText(DeviceError error) {
  switch (error) {
    case DeviceError::None: return "";
    case DeviceError::NetworkAccessPointFailed: return "Setup access point failed";
    case DeviceError::DisplayInitFailed: return "Display initialization failed";
  }
  return "Unknown device error";
}

enum class NetworkHint : uint8_t {
  None,
  NoCredentials,
  AccessPointActive,
  ConnectionFailed,
  Reconnecting,
  MdnsFailed
};

// Converts a network hint to its API key.
static inline const char* networkHintKey(NetworkHint hint) {
  switch (hint) {
    case NetworkHint::None: return "none";
    case NetworkHint::NoCredentials: return "no_credentials";
    case NetworkHint::AccessPointActive: return "access_point_active";
    case NetworkHint::ConnectionFailed: return "connection_failed";
    case NetworkHint::Reconnecting: return "reconnecting";
    case NetworkHint::MdnsFailed: return "mdns_failed";
  }
  return "unknown";
}

// Converts a network hint to display/API text.
static inline const char* networkHintText(NetworkHint hint) {
  switch (hint) {
    case NetworkHint::None: return "";
    case NetworkHint::NoCredentials: return "Connect to a network through the setup";
    case NetworkHint::AccessPointActive: return "Setup access point is active";
    case NetworkHint::ConnectionFailed: return "WiFi connection failed";
    case NetworkHint::Reconnecting: return "WiFi reconnecting";
    case NetworkHint::MdnsFailed: return "mDNS responder failed";
  }
  return "Unknown network hint";
}

struct SensorDisplaySummary {
  float measuredSeconds = 0.0f;
  int measuredFraction = 0;
  float deviationStops = 0.0f;

  // Clears the OLED calculation values for one sensor.
  void reset() {
    measuredSeconds = 0.0f;
    measuredFraction = 0;
    deviationStops = 0.0f;
  }
};

struct DisplayResultSummary {
  bool valid = false;
  int activatedCount = 0;
  float avgSeconds = 0.0f;
  int avgFraction = 0;
  float avgDeviationStops = 0.0f;
  float spreadStops = 0.0f;
  SensorDisplaySummary sensors[SENSOR_COUNT];

  // Clears the OLED result summary and all per-sensor display summaries.
  void reset() {
    valid = false;
    activatedCount = 0;
    avgSeconds = 0.0f;
    avgFraction = 0;
    avgDeviationStops = 0.0f;
    spreadStops = 0.0f;
    for (int i = 0; i < SENSOR_COUNT; i++) sensors[i].reset();
  }
};

struct MeasurementResult {
  bool valid = false;
  int activatedCount = 0;

  int64_t baseTimestamp = 0;
  SensorReading sensors[SENSOR_COUNT];
  FlashReading flash;
  MeasurementMode mode = MeasurementMode::HORIZONTAL;
  // Clears the raw measurement result, including all sensors, flash data, and mode.
  void reset() {
    valid = false;
    activatedCount = 0;
    baseTimestamp = 0;
    for (int i = 0; i < SENSOR_COUNT; i++) sensors[i].reset();
    flash.reset();
    mode = MeasurementMode::HORIZONTAL;
  }
};
