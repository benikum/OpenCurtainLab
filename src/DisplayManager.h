/*
 * Owns the OLED display and renders the ready, result, menu, splash, and power states.
 */

#pragma once
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "Config.h"
#include "MeasurementTypes.h"

class DisplayManager {
public:
  // Constructs the SSD1306 display object with the configured screen size.
  DisplayManager() : _display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1) {}

  // Initializes I2C, the OLED controller, display rotation, and splash screen.
  bool begin() {
    Wire.begin(I2C_SDA, I2C_SCL);
    if (!_display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS)) {
      Serial.println("[Display] Error: display not found!");
      return false;
    }
    _display.setRotation(DISPLAY_ROTATION);
    _display.setTextColor(SSD1306_WHITE);
    showSplash();
    return true;
  }

  // Draws the boot splash screen.
  void showSplash() {
    _display.clearDisplay();
    _display.setTextColor(SSD1306_WHITE);

    _drawLogo(6, 16);

    _display.setTextSize(2);
    _display.setCursor(44, 4);
    _display.print("Open");
    _display.setCursor(44, 25);
    _display.print("Curtain");
    _display.setCursor(44, 46);
    _display.print("Lab");

    _display.display();
  }

  // Switches the OLED panel off without losing display state.
  void sleep() {
    _display.ssd1306_command(SSD1306_DISPLAYOFF);
  }

  // Switches the OLED panel back on.
  void wake() {
    _display.ssd1306_command(SSD1306_DISPLAYON);
  }

  // Renders the ready screen including target time, mode, network line, and possible error/hint.
  void showReady(int targetFraction, MeasurementMode mode, const String& networkLine,
                 DeviceError deviceError = DeviceError::None,
                 MeasurementHint readyHint = MeasurementHint::None) {
    _display.ssd1306_command(SSD1306_DISPLAYON);
    _display.clearDisplay();
    _display.setTextColor(SSD1306_WHITE);
    _display.setTextSize(1);
    _display.setCursor(0, 0);

    if (deviceError != DeviceError::None) {
      _display.print("DEVICE ERROR");
      _display.drawLine(0, 10, SCREEN_WIDTH, 10, SSD1306_WHITE);
      _printWrapped(deviceErrorText(deviceError), 0, 20, 21, 3);
      _display.setCursor(0, 54);
      _printClipped(networkLine.length() ? networkLine.c_str() : "offline", 21);
      _display.display();
      return;
    }

    _display.print("READY");
    _drawModeIcon(mode, 105, 0);

    char buf[16];
    _formatFraction(buf, sizeof(buf), targetFraction, true);
    _display.setTextSize(3);
    int16_t x1, y1; uint16_t w, h;
    _display.getTextBounds(buf, 0, 0, &x1, &y1, &w, &h);
    _display.setCursor((SCREEN_WIDTH - w) / 2, 18);
    _display.print(buf);

    _display.setTextSize(1);
    _display.setCursor(0, 46);
    if (readyHint != MeasurementHint::None) _printClipped(measurementHintText(readyHint), 21);

    _display.setCursor(0, 54);
    _printClipped(networkLine.length() ? networkLine.c_str() : "offline", 21);
    _display.display();
  }

  // Renders the result summary page or the per-sensor result page.
  void showResult(const MeasurementResult& result, const DisplayResultSummary& summary, int targetFraction, MeasurementMode mode, uint8_t page = 1) {
    _display.ssd1306_command(SSD1306_DISPLAYON);
    (void)targetFraction;
    _display.clearDisplay();
    _display.setTextColor(SSD1306_WHITE);
    _display.setTextSize(1);

    // Invalid measurements still show the diagnostic hint instead of an empty result screen.
    if (!result.valid || result.activatedCount <= 0) {
      _display.setCursor(10, 12);
      _display.print("No valid");
      _display.setCursor(20, 26);
      _display.print("measurement");
      if (result.hint != MeasurementHint::None) {
        _printWrapped(measurementHintText(result.hint), 0, 42, 21, 2);
      }
      _display.display();
      return;
    }

    const bool capping = (result.activatedCount < SENSOR_COUNT && mode != MeasurementMode::CENTRAL);

    // Page 2 uses a fixed two-column layout for the five sensor raw/display summaries.
    if (page == 2) {
      for (int i = 0; i < SENSOR_COUNT; i++) {
        const int x = (i < 3) ? 0 : 68;
        const int y = (i < 3) ? i * 20 : (i - 3) * 20;
        _drawResultSensorCell(x, y, i, result.sensors[i], summary.sensors[i]);
      }
      _display.setCursor(68, 44);
      if (capping) _display.print("CAP");
      else if (result.hint != MeasurementHint::None) _printClipped(measurementHintKey(result.hint), 10);
      _display.display();
      return;
    }

    // Page 1 focuses on the average OLED summary, while raw values remain available through /data.
    char avgBuf[16];
    _formatFraction(avgBuf, sizeof(avgBuf), summary.avgFraction, true);
    _display.setTextSize(3);
    int16_t x1, y1; uint16_t w, h;
    _display.getTextBounds(avgBuf, 0, 0, &x1, &y1, &w, &h);
    _display.setCursor((SCREEN_WIDTH - w) / 2, 0);
    _display.print(avgBuf);

    _display.setTextSize(1);
    char devBuf[16];
    snprintf(devBuf, sizeof(devBuf), "%+.2f EV", summary.avgDeviationStops);
    _display.getTextBounds(devBuf, 0, 0, &x1, &y1, &w, &h);
    _display.setCursor((SCREEN_WIDTH - w) / 2, 34);
    _display.print(devBuf);

    char spreadBuf[20];
    snprintf(spreadBuf, sizeof(spreadBuf), "Spread %.2f EV", summary.spreadStops);
    _display.getTextBounds(spreadBuf, 0, 0, &x1, &y1, &w, &h);
    _display.setCursor((SCREEN_WIDTH - w) / 2, 50);
    _display.print(spreadBuf);

    if (capping) {
      _display.setCursor(0, 50);
      _display.print("CAP");
    }

    _display.display();
  }

  // Renders the scrollable local settings menu.
  void showMenu(uint8_t selected, const char* const* labels, const char* const* values, uint8_t count) {
    _display.ssd1306_command(SSD1306_DISPLAYON);
    _display.clearDisplay();
    _display.setTextColor(SSD1306_WHITE);
    _display.setTextSize(1);
    _display.setCursor(0, 0);
    _display.print("SETTINGS");
    _display.drawLine(0, 10, SCREEN_WIDTH, 10, SSD1306_WHITE);

    // The menu is windowed so a small display can still support more entries later.
    const uint8_t visible = 5;
    uint8_t first = 0;
    if (selected >= visible) first = selected - visible + 1;
    for (uint8_t row = 0; row < visible && first + row < count; row++) {
      const uint8_t idx = first + row;
      const int y = 14 + row * 10;
      if (idx == selected) {
        _display.fillRect(0, y - 1, SCREEN_WIDTH, 9, SSD1306_WHITE);
        _display.setTextColor(SSD1306_BLACK);
      } else {
        _display.setTextColor(SSD1306_WHITE);
      }
      const bool centeredAction = labels[idx] && strcmp(labels[idx], "Reset network") == 0;
      if (centeredAction) {
        int16_t x1, y1; uint16_t w, h;
        _display.getTextBounds(labels[idx], 0, 0, &x1, &y1, &w, &h);
        _display.setCursor((SCREEN_WIDTH - w) / 2, y);
        _display.print(labels[idx]);
      } else {
        _display.setCursor(2, y);
        _printClipped(labels[idx], 12);
        if (values && values[idx]) {
          _display.setCursor(78, y);
          _printClipped(values[idx], 8);
        }
      }
    }
    _display.setTextColor(SSD1306_WHITE);
    _display.display();
  }


private:
  Adafruit_SSD1306 _display;

  // Formats an exposure denominator for OLED display.
  static void _formatFraction(char* out, size_t len, int fraction, bool includeOne = false) {
    if (fraction <= 0) snprintf(out, len, "--");
    else if (fraction == 1) snprintf(out, len, includeOne ? "1s" : "1s");
    else snprintf(out, len, includeOne ? "1/%d" : "/%d", fraction);
  }


  // Draws one compact sensor result cell on the per-sensor page.
  void _drawResultSensorCell(int x, int y, int idx, const SensorReading& s, const SensorDisplaySummary& summary) {
    _display.setTextSize(1);
    _display.setCursor(x, y);
    _display.print("S");
    _display.print(idx);
    _display.print(" ");
    char frac[12];
    if (s.wasActivated && summary.measuredFraction > 0) _formatFraction(frac, sizeof(frac), summary.measuredFraction, true);
    else snprintf(frac, sizeof(frac), "---");
    _display.print(frac);
  }

  // Prints a short text block with simple word wrapping.
  void _printWrapped(const char* text, int16_t x, int16_t y, size_t maxCharsPerLine, uint8_t maxLines) {
    if (!text || !text[0] || maxLines == 0) return;

    const char* p = text;
    uint8_t line = 0;
    while (*p && line < maxLines) {
      while (*p == ' ') p++;
      if (!*p) break;

      // Prefer breaking at readable separators, then fall back to a hard split.
      size_t len = strlen(p);
      if (len > maxCharsPerLine) {
        len = maxCharsPerLine;
        for (size_t i = len; i > 0; --i) {
          if (p[i] == ' ' || p[i] == '-' || p[i] == '/') {
            len = i;
            break;
          }
        }
        if (len == 0) len = maxCharsPerLine;
      }

      char buf[24];
      size_t copyLen = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
      memcpy(buf, p, copyLen);
      buf[copyLen] = '\0';

      _display.setCursor(x, y + line * 10);
      _display.print(buf);

      p += len;
      line++;
    }
  }

  // Prints at most the requested number of characters.
  void _printClipped(const char* text, int maxChars) {
    if (!text) return;
    for (int i = 0; text[i] && i < maxChars; i++) _display.print(text[i]);
  }

  static constexpr uint8_t LOGO_BITMAP_WIDTH = 32;
  static constexpr uint8_t LOGO_BITMAP_HEIGHT = 32;
  static constexpr uint8_t LOGO_BITMAP[] PROGMEM = {
    0x00, 0x3F, 0xFC, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x03, 0xFF, 0xFF, 0xC0,
    0x07, 0xF0, 0x7F, 0xE0, 0x0F, 0xC0, 0x61, 0xF0, 0x1F, 0x00, 0xC0, 0xF8,
    0x3E, 0x00, 0xC0, 0x7C, 0x3E, 0x01, 0x80, 0x3C, 0x7B, 0x03, 0x80, 0x1E,
    0x73, 0x03, 0x00, 0x0E, 0xF1, 0x86, 0x00, 0x0F, 0xF0, 0xC7, 0xFF, 0xFF,
    0xE0, 0xCF, 0xFF, 0xFF, 0xE0, 0x6F, 0xF0, 0x07, 0xE0, 0x7F, 0xF0, 0x07,
    0xE0, 0x3F, 0xF8, 0x07, 0xE0, 0x1F, 0xFC, 0x07, 0xE0, 0x0F, 0xFE, 0x07,
    0xE0, 0x0F, 0xF6, 0x07, 0xFF, 0xFF, 0xF3, 0x07, 0xFF, 0xFF, 0xE3, 0x0F,
    0xF0, 0x00, 0x61, 0x8F, 0x70, 0x00, 0xC0, 0xDE, 0x78, 0x01, 0xC0, 0xDE,
    0x3C, 0x01, 0x80, 0x7C, 0x3E, 0x03, 0x00, 0x7C, 0x1F, 0x03, 0x00, 0xF8,
    0x0F, 0x86, 0x03, 0xF0, 0x07, 0xFE, 0x0F, 0xE0, 0x03, 0xFF, 0xFF, 0xC0,
    0x00, 0xFF, 0xFF, 0x00, 0x00, 0x3F, 0xFC, 0x00
  };

  // Draws the built-in bitmap logo at the requested position.
  void _drawLogo(int x, int y) {
    _display.drawBitmap(x, y, LOGO_BITMAP, LOGO_BITMAP_WIDTH, LOGO_BITMAP_HEIGHT, SSD1306_WHITE);
  }

  // Draws the shutter measurement mode icon inside a fixed frame.
  void _drawModeIcon(MeasurementMode mode, int x, int y) {
    _display.drawRect(x, y, 21, 15, SSD1306_WHITE);

    const int cx = x + 10;
    const int cy = y + 7;
    if (mode == MeasurementMode::CENTRAL) {
      _display.drawCircle(cx, cy, 5, SSD1306_WHITE);
      _display.fillCircle(cx, cy, 1, SSD1306_WHITE);
      return;
    }

    if (mode == MeasurementMode::VERTICAL) {
      _display.drawLine(cx, y + 3, cx, y + 11, SSD1306_WHITE);
      _display.drawLine(cx, y + 3, cx - 3, y + 6, SSD1306_WHITE);
      _display.drawLine(cx, y + 3, cx + 3, y + 6, SSD1306_WHITE);
      _display.drawLine(cx, y + 11, cx - 3, y + 8, SSD1306_WHITE);
      _display.drawLine(cx, y + 11, cx + 3, y + 8, SSD1306_WHITE);
      return;
    }

    _display.drawLine(x + 4, cy, x + 16, cy, SSD1306_WHITE);
    _display.drawLine(x + 4, cy, x + 7, cy - 3, SSD1306_WHITE);
    _display.drawLine(x + 4, cy, x + 7, cy + 3, SSD1306_WHITE);
    _display.drawLine(x + 16, cy, x + 13, cy - 3, SSD1306_WHITE);
    _display.drawLine(x + 16, cy, x + 13, cy + 3, SSD1306_WHITE);
  }

};
