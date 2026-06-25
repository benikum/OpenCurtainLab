# OpenCurtainLab Build Guide

This guide explains how to build an OpenCurtainLab device from parts, PCB or perfboard layouts, 3D-printed parts, wiring, and firmware configuration.

The images in this guide are JPG placeholders. Replace them with real photos, PCB renders, wiring diagrams, exported schematics, and printed-part photos before publishing a final hardware release.

![Finished device placeholder](images/device-overview.jpg)

## 1. Parts and example sources

The AliExpress links are example sources from the prototype documentation. Verify package size, electrical ratings, connector type, seller availability, shipping, and dimensions before ordering.

| Qty | Part | Purpose | Notes | Example source |
|---:|---|---|---|---|
| 1 | ESP-WROOM-32 / ESP32 development board | Main controller | Must expose the configured ADC and GPIO pins. | [AliExpress](https://de.aliexpress.com/item/1005010464014217.html) |
| 5 | NPN phototransistor, for example PT2046C | Light sensors | One per sensor channel. | [AliExpress](https://de.aliexpress.com/item/1005003285240345.html) |
| 5 | 10 kΩ resistor | Sensor pull-up resistors | Sensor channel should idle high and be pulled down by light. | Local supplier |
| 1 | 128×64 SSD1306 OLED display | Local status display | I2C, default address `0x3C`. | [AliExpress](https://de.aliexpress.com/item/1005006141235306.html) |
| 3 | Momentary push button / DIP-style tactile switch | Local controls | Active-low buttons to GND. | [AliExpress](https://de.aliexpress.com/item/1005004971266223.html) |
| 1 | 3.5 mm jack socket | Flash-sync input | Optional. | [AliExpress](https://de.aliexpress.com/item/1005005562420070.html) |
| 1 | 3.5 mm flash-sync cable | Camera flash-sync cable | Optional, depending on camera/adapter. | [AliExpress](https://de.aliexpress.com/item/1005006828170608.html) |
| 1 | Hot-shoe converter or flash-sync adapter | Camera flash-sync connection | Optional, depending on camera. | [AliExpress](https://de.aliexpress.com/item/1005003922472021.html) |
| 1 | 3.3 V DC/DC buck converter | Power supply | Required if the battery voltage is above ESP32 input limits and no suitable board regulator is used. | [AliExpress](https://de.aliexpress.com/item/1005008257960729.html) |
| 1 | Perfboard or custom PCB | Electronics carrier | Use perfboard for a prototype or replace with final PCB files. | Local supplier |
| 1 | 330 kΩ resistor | Battery divider high side | Optional battery monitor. Measure the real installed value and enter it in firmware. | Local supplier |
| 1 | 100 kΩ resistor | Battery divider low side | Optional battery monitor. Measure the real installed value and enter it in firmware. | Local supplier |
| 1 | 100 nF capacitor | Battery ADC smoothing | Optional but recommended. | Local supplier |
| as needed | 40-pin Dupont wires or headers | Internal wiring | Match your board and enclosure design. | [AliExpress](https://de.aliexpress.com/item/1005009071621102.html) |
| as needed | Screws, inserts, spacers, heat-shrink, strain relief | Mechanical assembly | Match your enclosure and printed parts. | Local supplier |
| as needed | 3D-printed case and sensor holder | Mechanical assembly | Replace placeholders with final STL/STEP files. | Printed locally |

![Parts overview placeholder](images/bom-overview.jpg)

## 2. Tools

Recommended tools:

- Soldering iron and solder.
- Wire stripper and side cutter.
- Multimeter.
- Computer with Arduino IDE or Arduino CLI.
- USB cable for the ESP32 board.
- 3D printer or access to printed parts.
- Camera body and stable light source for validation.

## 3. Electrical design

### 3.1 ESP32 pinout

The default pinout is defined in `src/Config.h`.

| Function | Firmware symbol | Default pin |
|---|---|---:|
| Sensor 0 | `PIN_SENSOR_0` | GPIO36 |
| Sensor 1 | `PIN_SENSOR_1` | GPIO39 |
| Sensor 2 | `PIN_SENSOR_2` | GPIO34 |
| Sensor 3 | `PIN_SENSOR_3` | GPIO35 |
| Sensor 4 | `PIN_SENSOR_4` | GPIO32 |
| Battery ADC | `PIN_BATTERY_ADC` | GPIO33 |
| Flash sync | `PIN_FLASH_SENSOR` | GPIO14 |
| Up button | `PIN_BTN_UP` | GPIO25 |
| Down button | `PIN_BTN_DOWN` | GPIO26 |
| Listen button | `PIN_BTN_LISTEN` | GPIO27 |
| OLED SDA | `I2C_SDA` | GPIO21 |
| OLED SCL | `I2C_SCL` | GPIO22 |

![Schematic overview placeholder](images/schematic-overview.jpg)

### 3.2 Phototransistor channels

Each sensor channel must produce a high ADC value in darkness and a lower ADC value when light reaches the phototransistor.

Recommended circuit per sensor:

```text
3.3 V ---- 10 kΩ ----+---- ESP32 ADC pin
                     |
              phototransistor
                     |
GND -----------------+
```

In this arrangement, the resistor pulls the ADC input up in darkness. When the phototransistor conducts under light, the ADC input is pulled downward.

Firmware detection model:

| Sensitivity | Active when raw is at or below | Released when raw is at or above |
|---|---:|---:|
| Low | 1100 | 1250 |
| Medium | 2100 | 2250 |
| High | 3100 | 3250 |

Use `GET /sensors` or the WebUI sensor diagnostics to verify that dark readings are close to the upper ADC range and illuminated readings cross the selected threshold.

![Sensor wiring placeholder](images/wiring-sensors.jpg)

### 3.3 Flash-sync input

The flash-sync input is optional. It is active-low and uses the ESP32 internal pull-up.

Recommended wiring:

```text
3.5 mm jack tip    ---- GPIO14 / PIN_FLASH_SENSOR
3.5 mm jack sleeve ---- GND
```

When the camera closes the flash-sync contact, the input is pulled to GND and the firmware records `flash.triggerUs`.

### 3.4 OLED display

Connect the SSD1306 OLED over I2C:

```text
OLED VCC  -> 3.3 V
OLED GND  -> GND
OLED SDA  -> GPIO21
OLED SCL  -> GPIO22
```

Default firmware settings:

```cpp
#define OLED_ADDRESS 0x3C
#define DISPLAY_ROTATION 2
```

### 3.5 Buttons

All buttons are active-low. Wire each button between the configured GPIO and GND.

```text
GPIO25 -- Up button ---- GND
GPIO26 -- Down button -- GND
GPIO27 -- Listen button - GND
```

The firmware enables internal pull-ups and handles debounce.

### 3.6 Optional battery monitor

The optional battery monitor uses a nominal 330 kΩ / 100 kΩ voltage divider.

Recommended circuit:

```text
Battery + ---- 330 kΩ ----+---- GPIO33 / PIN_BATTERY_ADC
                          |
                        100 kΩ
                          |
GND ----------------------+
```

Recommended addition:

```text
GPIO33 ---- 100 nF ---- GND
```

Measure the actual installed resistor values with a multimeter and enter those measured values in `src/Config.h`. This improves the battery voltage calculation and avoids documenting nominal resistor values as if they were precision values.

Example for measured prototype values:

```cpp
#define BATTERY_DIVIDER_HIGH_OHMS 324400.0f
#define BATTERY_DIVIDER_LOW_OHMS   99100.0f
```

If you use only nominal values, enter:

```cpp
#define BATTERY_DIVIDER_HIGH_OHMS 330000.0f
#define BATTERY_DIVIDER_LOW_OHMS  100000.0f
```

The battery monitor can be disabled in firmware by setting:

```cpp
static constexpr bool BATTERY_MONITOR_ENABLED = false;
```

Battery percentage is calculated from the configured voltage range:

```cpp
#define BATTERY_EMPTY_VOLTAGE 7.0f
#define BATTERY_FULL_VOLTAGE  9.3f
```

![Power wiring placeholder](images/wiring-power.jpg)

## 4. PCB layouts and schematics

You can build the first version on perfboard or design custom PCBs. The documentation expects two layout concepts:

1. Main/control board: ESP32, OLED connector, buttons, flash-sync jack, power input, battery divider.
2. Sensor board: five phototransistor channels with fixed spacing and a connector to the main board.

Placeholders:

![Control PCB layout placeholder](images/pcb-control-layout.jpg)

![Sensor PCB layout placeholder](images/pcb-sensor-layout.jpg)

Recommended PCB notes:

- Keep sensor traces short and consistent.
- Add a ground reference close to the sensor connector.
- Label every connector with pin names and orientation.
- Keep the battery divider away from noisy switching nodes.
- Add test pads for 3.3 V, GND, each ADC channel, and flash sync.
- Confirm that the ESP32 ADC pins match `src/Config.h`.

Suggested repository locations for final hardware files:

```text
hardware/pcb/main-board/
hardware/pcb/sensor-board/
hardware/schematics/
hardware/gerbers/
```

## 5. 3D-printed parts

The mechanical parts should hold the sensor board in a repeatable position relative to the camera film gate and keep external light leaks low.

![3D-printed parts placeholder](images/3d-printed-parts.jpg)

Recommended printed parts:

| Part | Purpose |
|---|---|
| Sensor holder | Positions the five phototransistors at the film gate. |
| Main enclosure | Holds ESP32, display, buttons, jack, and power input. |
| Cable strain relief | Protects wires between main enclosure and sensor holder. |
| Light shield | Reduces ambient-light leakage around the shutter opening. |

Suggested repository locations for final files:

```text
hardware/3d-print/stl/
hardware/3d-print/step/
hardware/3d-print/photos/
```

Mechanical checks:

- The sensor board must not scratch film rails or shutter curtains.
- The sensor holder must not touch or obstruct the shutter.
- The sensor spacing must match the firmware geometry or `src/Config.h` must be updated.
- Use matte dark material or shielding where possible to reduce reflections.

## 6. Assembly steps

### Step 1: Prepare the boards

1. Print or manufacture the main PCB and sensor PCB, or cut perfboard to size.
2. Inspect all pads and tracks.
3. Mark connector orientation and pin numbers.
4. Do not install the ESP32 yet.

### Step 2: Assemble the sensor channels

1. Install the five phototransistors.
2. Install one 10 kΩ pull-up resistor per sensor channel.
3. Connect each sensor node to the matching ESP32 ADC pin.
4. Connect all sensor grounds to the common ground.
5. Check with a multimeter that there is no short between 3.3 V and GND.

### Step 3: Assemble controls and display

1. Wire the OLED to 3.3 V, GND, SDA, and SCL.
2. Wire the three buttons to their GPIO pins and GND.
3. Install the flash-sync jack if used.
4. Install the battery divider if used.

### Step 4: Install power wiring

1. Verify the buck converter output before connecting the ESP32.
2. Confirm that the ESP32 receives a safe voltage for your board.
3. Connect all grounds together.
4. Add strain relief for external cables.

### Step 5: Install the ESP32

1. Insert or solder the ESP32 board.
2. Verify orientation.
3. Power the board from USB first.
4. Confirm that the OLED initializes.

### Step 6: Mechanical assembly

1. Install the sensor board into the printed sensor holder.
2. Install the main electronics into the enclosure.
3. Route cables without sharp bends.
4. Close the enclosure only after firmware and sensor diagnostics pass.

## 7. Firmware configuration

Open `src/Config.h` and adjust values for your hardware.

Common settings:

| Setting | Meaning |
|---|---|
| `FIRMWARE_VERSION` | Firmware/API/WebUI version. Usually managed by `tools/release.py`. |
| `PIN_SENSOR_0` … `PIN_SENSOR_4` | Sensor ADC pins. |
| `PIN_FLASH_SENSOR` | Active-low flash-sync input. |
| `PIN_BATTERY_ADC` | Battery voltage ADC input. |
| `BATTERY_MONITOR_ENABLED` | Set to `false` if the divider is not installed. |
| `BATTERY_DIVIDER_HIGH_OHMS` / `BATTERY_DIVIDER_LOW_OHMS` | Measured resistor values of the installed battery divider. |
| `BATTERY_EMPTY_VOLTAGE` / `BATTERY_FULL_VOLTAGE` | Voltage range used for battery percentage. |
| `SENSOR_DISTANCE_X_MM` | Physical horizontal spacing between neighboring sensors. |
| `SENSOR_DISTANCE_Y_MM` | Physical vertical spacing between neighboring sensors. |
| `SENSOR_ON_THRESHOLD_*` | ADC activation thresholds. |
| `SENSOR_OFF_THRESHOLD_*` | ADC release thresholds. |
| `DEFAULT_MEASUREMENT_MODE` | Startup mode: `horizontal`, `vertical`, or `central`. |
| `DEFAULT_TARGET_TIME` | Startup target shutter denominator. |

![Firmware configuration placeholder](images/firmware-config.jpg)

### 7.1 Firmware libraries

Install these libraries in Arduino IDE or make them available to Arduino CLI:

| Dependency | Used for |
|---|---|
| ESP32 Arduino core | WiFi, WebServer, Preferences, mDNS, ADC, GPIO, timing. |
| ArduinoJson | JSON parsing and serialization. |
| Adafruit GFX Library | OLED graphics base layer. |
| Adafruit SSD1306 | OLED display driver. |
| Wire | I2C transport, included with Arduino/ESP32 core. |

### 7.2 Arduino IDE upload

1. Install the ESP32 board package.
2. Install the firmware libraries listed above.
3. Open `OpenCurtainLab.ino`.
4. Select your ESP32 board and port.
5. Compile and upload.

### 7.3 Release helper

Before publishing release files or when changing WebUI/setup portal files, run:

```bash
python3 -m pip install minify-html
python3 tools/release.py
```

For local checks without manifest publication:

```bash
python3 tools/release.py --skip-manifest-check
node --check web/app.js
node --check web/js/*.js
```

## 8. Validation after assembly

Follow the first-start steps in the [README](../README.md#first-start), then validate the hardware before making real measurements.

Use the WebUI diagnostics or call:

```bash
curl http://opencurtainlab.local/sensors
```

Validation checklist:

- Dark sensor readings are high.
- Illuminated sensor readings cross the selected ON threshold.
- Each sensor changes independently.
- Flash-sync input is inactive when open and active when shorted to GND.
- OLED reports the expected WiFi and measurement state.
- Battery voltage is plausible if the battery monitor is installed.

If a measurement reports `incomplete_sensor_coverage`, check alignment, light level, sensor thresholds, and whether the shutter opening covers all five sensors.

## 9. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Setup portal does not appear | Device is not in AP mode or power issue | OLED status, serial log, `OpenCurtainLab` WiFi network. |
| `opencurtainlab.local` does not resolve | mDNS unavailable on client | Use the IP address shown on the OLED. |
| Sensor is always active | Light leak, wrong wiring, low threshold margin | Check raw value through `/sensors`. |
| Sensor never activates | Phototransistor orientation, missing pull-up, insufficient light | Check ADC voltage and raw value. |
| Flash is always active | Jack wiring shorted to GND | Check GPIO14 against GND. |
| Battery shows `0 V` | Battery monitor disabled or divider missing | Check `BATTERY_MONITOR_ENABLED` and divider wiring. |
| OLED stays blank | I2C address, wiring, display failure | Check SDA/SCL, VCC, GND, and `OLED_ADDRESS`. |
