/*
 * Defines firmware identity, hardware pins, sensor geometry, timing constants, WiFi behavior, and factory defaults.
 */

#pragma once
#include <Arduino.h>

// Project / URLs
#define DEVICE_NAME        "OpenCurtainLab"
#define FIRMWARE_VERSION   "0.1.0"
#define MDNS_NAME          "opencurtainlab"
#define GITHUB_PROJECT_URL "https://github.com/benikum/OpenCurtainLab"
#define WEB_APP_URL "https://raw.githubusercontent.com/benikum/OpenCurtainLab/refs/heads/main/web/compiled/opencurtainlab.html"
#define WEB_APP_DOWNLOAD_FILENAME      "opencurtainlab.html"

// Proxy to GitHub Raw
#define WEB_APP_PROXY_TIMEOUT_MS       12000UL
#define WEB_APP_PROXY_IDLE_TIMEOUT_MS  6000UL
#define WEB_APP_PROXY_CHUNK_SIZE       1024

// WiFi / Setup AP
#define SETUP_AP_SSID               "OpenCurtainLab"
#define SETUP_AP_PASSWORD           ""
#define WIFI_CONNECT_TIMEOUT_MS     12000UL
#define WIFI_RECONNECT_INTERVAL_MS  30000UL
#define WIFI_FALLBACK_TO_AP_TIMEOUT_MS 90000UL
#define MDNS_RETRY_INTERVAL_MS     10000UL

// Hardware Pins
#define PIN_SENSOR_0      36
#define PIN_SENSOR_1      39
#define PIN_SENSOR_2      34
#define PIN_SENSOR_3      35
#define PIN_SENSOR_4      32
#define PIN_FLASH_SENSOR  33

#define PIN_BTN_LISTEN    25
#define PIN_BTN_UP        26
#define PIN_BTN_DOWN      27

#define PIN_LED_ARRAY     12
#define PIN_LAMP_SENSE   14

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

// Sensor Sampling
#define SENSOR_BASELINE_SAMPLES      5
#define SENSOR_BASELINE_DURATION_MS  250UL
#define SENSOR_BASELINE_MIN_RAW      1200

// Runtime sensitivity presets derive ADC hysteresis thresholds for low/medium/high.
#define SENSOR_ON_DELTA_LOW     3000
#define SENSOR_OFF_DELTA_LOW    2900
#define SENSOR_ON_DELTA_MEDIUM  2000
#define SENSOR_OFF_DELTA_MEDIUM 1900
#define SENSOR_ON_DELTA_HIGH    1000
#define SENSOR_OFF_DELTA_HIGH    900

// Measurement Timing
#define MEASUREMENT_TIMEOUT_MS       5000UL
#define MEASUREMENT_SETTLE_MS        15UL
#define MEASUREMENT_LATE_SENSOR_SETTLE_MS 120UL
#define FLASH_TO_SENSOR_TIMEOUT_MS   250UL
#define LED_HOLD_MS                  1000UL

// Buttons
#define DEBOUNCE_MS       50UL
#define MODE_HOLD_MS      1000UL

// Factory defaults for runtime settings
#define DEFAULT_MEASUREMENT_MODE "left"
#define DEFAULT_TARGET_TIME      500
#define DEVICE_MAX_TARGET_TIME  2000
#define DEFAULT_SENSOR_SENSITIVITY "medium"
#define DEFAULT_RESULT_DISPLAY "until_button"
#define DEFAULT_OLED_SLEEP_MINUTES 5
