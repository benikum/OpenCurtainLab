/*
 * Debounces the three hardware buttons and converts them into short-press and repeated long-press events.
 */

#pragma once

#include <Arduino.h>
#include "Config.h"

struct ButtonEvents {
  bool selectPressed = false;
  bool upPressed     = false;
  bool downPressed   = false;

  bool selectLongPressed = false;
  bool upLongPressed     = false;
  bool downLongPressed   = false;

  // Returns true when any short or long button event is set.
  bool anyPressed() const {
    return selectPressed || upPressed || downPressed || selectLongPressed || upLongPressed || downLongPressed;
  }

  // Resets all button event flags.
  void clear() { *this = ButtonEvents(); }
};

class ButtonManager {
public:
  // Configures button pins and initializes their debounce trackers.
  void begin() {
    pinMode(PIN_BTN_SELECT, INPUT_PULLUP);
    pinMode(PIN_BTN_UP,     INPUT_PULLUP);
    pinMode(PIN_BTN_DOWN,   INPUT_PULLUP);

    _select.begin(PIN_BTN_SELECT, MODE_HOLD_MS);
    _up.begin(PIN_BTN_UP, MODE_HOLD_MS);
    _down.begin(PIN_BTN_DOWN, MODE_HOLD_MS);

    Serial.println(F("[Buttons] Polling aktiv."));
  }

  // Reads all buttons and returns the events detected during this poll.
  ButtonEvents poll() {
    ButtonEvents ev;
    const unsigned long now = millis();
    _select.update(now, ev.selectPressed, ev.selectLongPressed);
    _up.update(now, ev.upPressed, ev.upLongPressed);
    _down.update(now, ev.downPressed, ev.downLongPressed);
    return ev;
  }

private:
  struct DebouncedButton {
    uint8_t pin = 255;
    bool stableState = HIGH;
    bool lastRawState = HIGH;
    bool longEventSent = false;
    unsigned long changedAt = 0;
    unsigned long pressedAt = 0;
    unsigned long nextRepeatAt = 0;
    unsigned long longMs = 1000;

    // Initializes a single debounced button tracker.
    void begin(uint8_t buttonPin, unsigned long longPressMs) {
      pin = buttonPin;
      longMs = longPressMs;
      stableState = digitalRead(pin);
      lastRawState = stableState;
      changedAt = millis();
      pressedAt = 0;
      longEventSent = false;
      nextRepeatAt = 0;
    }

    // Updates one button state and emits short or repeated long press events.
    void update(unsigned long now, bool& shortPress, bool& longPress) {
      shortPress = false;
      longPress = false;
      const bool rawState = digitalRead(pin);

      if (rawState != lastRawState) {
        lastRawState = rawState;
        changedAt = now;
      }

      if ((now - changedAt) >= DEBOUNCE_MS && rawState != stableState) {
        stableState = rawState;
        if (stableState == LOW) {
          pressedAt = now;
          longEventSent = false;
          nextRepeatAt = now + longMs;
        } else {
          if (!longEventSent && pressedAt > 0) shortPress = true;
          pressedAt = 0;
          longEventSent = false;
          nextRepeatAt = 0;
        }
      }

      if (stableState == LOW && pressedAt > 0 && nextRepeatAt > 0 && now >= nextRepeatAt) {
        longEventSent = true;
        longPress = true;
        nextRepeatAt += longMs;
      }
    }
  };

  DebouncedButton _select;
  DebouncedButton _up;
  DebouncedButton _down;
};
