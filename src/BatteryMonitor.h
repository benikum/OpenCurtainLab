/*
 * Reads the divided battery voltage on an ADC1 pin and exposes the calculated
 * battery voltage before the voltage divider for /status.
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
      _batteryVoltage = 0.0f;
      _adcPinVoltage = 0.0f;
      Serial.println(F("[Battery] Monitor disabled in Config.h"));
      return;
    }

    pinMode(PIN_BATTERY_ADC, INPUT);
    analogSetPinAttenuation(PIN_BATTERY_ADC, ADC_11db);
    readVoltagesNow(_adcPinVoltage, _batteryVoltage);
    Serial.printf(
      "[Battery] Monitor initialized on GPIO %u: ADC %.2f V -> Battery %.2f V (divider %.3fx)\n",
      (unsigned int)PIN_BATTERY_ADC,
      _adcPinVoltage,
      _batteryVoltage,
      dividerRatio()
    );
  }

  void update() {
    if (!BATTERY_MONITOR_ENABLED) return;

    const unsigned long now = millis();
    if (!_initialized || (now - _lastUpdateMs) < BATTERY_UPDATE_INTERVAL_MS) return;
    _lastUpdateMs = now;

    float nextAdcPinVoltage = 0.0f;
    float nextBatteryVoltage = 0.0f;
    readVoltagesNow(nextAdcPinVoltage, nextBatteryVoltage);

    if (_batteryVoltage <= 0.0f) {
      _adcPinVoltage = nextAdcPinVoltage;
      _batteryVoltage = nextBatteryVoltage;
    } else {
      _adcPinVoltage = (_adcPinVoltage * 0.75f) + (nextAdcPinVoltage * 0.25f);
      _batteryVoltage = (_batteryVoltage * 0.75f) + (nextBatteryVoltage * 0.25f);
    }
  }

  // Voltage at the battery before the divider. This is the value reported via /status.
  float batteryVoltage() const { return BATTERY_MONITOR_ENABLED ? _batteryVoltage : 0.0f; }

  // Voltage actually present on the ESP32 ADC pin after the divider, useful for debugging only.
  float adcPinVoltage() const { return BATTERY_MONITOR_ENABLED ? _adcPinVoltage : 0.0f; }

private:
  float _batteryVoltage = 0.0f;
  float _adcPinVoltage = 0.0f;
  unsigned long _lastUpdateMs = 0;
  bool _initialized = false;

  static float dividerRatio() {
    return (BATTERY_DIVIDER_HIGH_OHMS + BATTERY_DIVIDER_LOW_OHMS) / BATTERY_DIVIDER_LOW_OHMS;
  }

  static void readVoltagesNow(float& adcPinVoltage, float& batteryVoltage) {
    // Discard one sample after the ADC channel switch, then average a few calibrated millivolt reads.
    (void)analogRead(PIN_BATTERY_ADC);
    delayMicroseconds(50);

    uint32_t sumMv = 0;
    for (int i = 0; i < BATTERY_ADC_SAMPLES; i++) {
      sumMv += (uint32_t)analogReadMilliVolts(PIN_BATTERY_ADC);
      delayMicroseconds(50);
    }

    adcPinVoltage = ((float)sumMv / (float)BATTERY_ADC_SAMPLES) / 1000.0f;
    batteryVoltage = adcPinVoltage * dividerRatio();
  }
};
