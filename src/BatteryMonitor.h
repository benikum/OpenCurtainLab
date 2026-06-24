/*
 * Reads the divided battery voltage on an ADC1 pin and exposes the calculated voltage for /status.
 */

#pragma once
#include <Arduino.h>
#include "Config.h"

class BatteryMonitor {
public:
  void begin() {
    _initialized = true;
    _lastUpdateMs = millis();

    if (!BATTERY_MONITOR_ENABLED) {
      _voltage = 0.0f;
      Serial.println(F("[Battery] Monitor disabled in Config.h"));
      return;
    }

    pinMode(PIN_BATTERY_ADC, INPUT);
    analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);
    _voltage = readVoltageNow();
    Serial.printf("[Battery] Monitor initialized on GPIO %u: %.2f V\n", (unsigned int)PIN_BATTERY_ADC, _voltage);
  }

  void update() {
    if (!BATTERY_MONITOR_ENABLED) return;

    const unsigned long now = millis();
    if (!_initialized || (now - _lastUpdateMs) < BATTERY_UPDATE_INTERVAL_MS) return;
    _lastUpdateMs = now;

    const float next = readVoltageNow();
    if (_voltage <= 0.0f) {
      _voltage = next;
    } else {
      _voltage = (_voltage * 0.75f) + (next * 0.25f);
    }
  }

  float voltage() const { return BATTERY_MONITOR_ENABLED ? _voltage : 0.0f; }

private:
  float _voltage = 0.0f;
  unsigned long _lastUpdateMs = 0;
  bool _initialized = false;

  static float dividerRatio() {
    return (BATTERY_DIVIDER_HIGH_OHMS + BATTERY_DIVIDER_LOW_OHMS) / BATTERY_DIVIDER_LOW_OHMS;
  }

  static float readVoltageNow() {
    // Discard one sample after the ADC channel switch, then average a few reads for a steadier value.
    (void)analogRead(PIN_BATTERY_ADC);
    delayMicroseconds(50);

    uint32_t sum = 0;
    for (int i = 0; i < BATTERY_ADC_SAMPLES; i++) {
      sum += (uint32_t)analogRead(PIN_BATTERY_ADC);
      delayMicroseconds(50);
    }

    const float raw = (float)sum / (float)BATTERY_ADC_SAMPLES;
    const float adcVoltage = (raw * 3.3f) / 4095.0f;
    return adcVoltage * dividerRatio();
  }
};
