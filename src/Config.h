/*
 * Defines firmware identity, hardware pins, sensor geometry, timing constants, WiFi behavior, and factory defaults.
 */

#pragma once
#include <Arduino.h>

// Project / URLs
#define DEVICE_NAME                 "OpenCurtainLab"
#define FIRMWARE_VERSION            "0.1.0"
#define MDNS_NAME                   "opencurtainlab"
#define GITHUB_PROJECT_URL          "https://github.com/benikum/OpenCurtainLab"
#define WEB_MANIFEST_URL            "https://raw.githubusercontent.com/benikum/OpenCurtainLab/refs/heads/main/web/manifest.json"
#define WEB_APP_DOWNLOAD_FILENAME   "opencurtainlab.html"

// Remote manifest/download proxy
#define WEB_MANIFEST_TIMEOUT_MS        8000UL
#define WEB_APP_PROXY_TIMEOUT_MS       12000UL
#define WEB_APP_STREAM_BUFFER_SIZE     1024

// WiFi / Setup AP
#define SETUP_AP_SSID                    "OpenCurtainLab"
#define SETUP_AP_PASSWORD                ""
#define WIFI_CONNECT_TIMEOUT_MS          12000UL
#define WIFI_RECONNECT_INTERVAL_MS       30000UL
#define WIFI_FALLBACK_TO_AP_TIMEOUT_MS   90000UL
#define MDNS_RETRY_INTERVAL_MS           10000UL

// Hardware Pins
#define PIN_SENSOR_0      36
#define PIN_SENSOR_1      39
#define PIN_SENSOR_2      34
#define PIN_SENSOR_3      35
#define PIN_SENSOR_4      32
#define PIN_BATTERY_ADC   33
#define PIN_FLASH_SENSOR  14

// Button Pins
#define PIN_BTN_UP        25
#define PIN_BTN_DOWN      26
#define PIN_BTN_LISTEN    27

// Optional battery voltage monitor. Set this to false when the voltage divider is not installed.
static constexpr bool BATTERY_MONITOR_ENABLED = true;
#define BATTERY_DIVIDER_HIGH_OHMS  324400.0f
#define BATTERY_DIVIDER_LOW_OHMS   99100.0f
#define BATTERY_EMPTY_VOLTAGE      7.0f
#define BATTERY_FULL_VOLTAGE       9.3f
#define BATTERY_ADC_SAMPLES        8
#define BATTERY_UPDATE_INTERVAL_MS 1000UL

// Display / I2C
#define I2C_SDA              21
#define I2C_SCL              22
#define OLED_ADDRESS         0x3C
#define SCREEN_WIDTH         128
#define SCREEN_HEIGHT        64
#define DISPLAY_ROTATION     2

// Sensor Geometry
static constexpr int SENSOR_COUNT = 5;
static constexpr float SENSOR_DISTANCE_X_MM = 13.17f;
static constexpr float SENSOR_DISTANCE_Y_MM = 7.67f;

// Runtime sensitivity presets use absolute ADC hysteresis thresholds.
// Phototransistors are expected to pull the ADC value downward when light reaches a sensor.
// Active: raw <= ON threshold. Released: raw >= OFF threshold.
#define SENSOR_ON_THRESHOLD_LOW      1100
#define SENSOR_OFF_THRESHOLD_LOW     1250
#define SENSOR_ON_THRESHOLD_MEDIUM   2100
#define SENSOR_OFF_THRESHOLD_MEDIUM  2250
#define SENSOR_ON_THRESHOLD_HIGH     3100
#define SENSOR_OFF_THRESHOLD_HIGH    3250

// Measurement Timing
#define MEASUREMENT_TIMEOUT_MS       5000UL
#define MEASUREMENT_SETTLE_MS        15UL
#define MEASUREMENT_LATE_SENSOR_SETTLE_MS 120UL
#define FLASH_TO_SENSOR_TIMEOUT_MS   250UL

// Buttons
#define DEBOUNCE_MS       50UL
#define MODE_HOLD_MS      1000UL

// Factory defaults for runtime settings
#define DEFAULT_MEASUREMENT_MODE    "horizontal"
#define DEFAULT_TARGET_TIME         500
#define DEVICE_MAX_TARGET_TIME      2000
#define DEFAULT_SENSOR_SENSITIVITY  "medium"
#define DEFAULT_RESULT_DISPLAY      "until_button"
#define DEFAULT_OLED_SLEEP_MINUTES  5
