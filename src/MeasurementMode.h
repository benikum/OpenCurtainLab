/*
 * Defines shutter travel directions and converts them to and from stable API/settings keys.
 */

#pragma once
#include <Arduino.h>

enum class MeasurementMode : uint8_t {
  LEFT = 0,
  DOWN = 1,
  RIGHT = 2,
  UP = 3,
  CENTRAL = 4
};

// Converts a measurement mode enum value to its stable API/settings key.
static inline const char* measurementModeKey(MeasurementMode mode) {
  switch (mode) {
    case MeasurementMode::LEFT:    return "left";
    case MeasurementMode::DOWN:    return "down";
    case MeasurementMode::RIGHT:   return "right";
    case MeasurementMode::UP:      return "up";
    case MeasurementMode::CENTRAL: return "central";
  }
  return "left";
}

// Parses a stable mode key and falls back to left travel.
static inline MeasurementMode measurementModeFromKey(const String& key) {
  if (key == "down") return MeasurementMode::DOWN;
  if (key == "right") return MeasurementMode::RIGHT;
  if (key == "up") return MeasurementMode::UP;
  if (key == "central") return MeasurementMode::CENTRAL;
  return MeasurementMode::LEFT;
}

// Returns the next mode in the local button cycle.
static inline MeasurementMode nextMeasurementMode(MeasurementMode mode) {
  return static_cast<MeasurementMode>((static_cast<uint8_t>(mode) + 1) % 5);
}
