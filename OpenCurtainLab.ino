/*
 * Coordinates the OpenCurtainLab application state, buttons, display, sensors, measurement engine, settings, and web API.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include "src/Config.h"
#include "src/MeasurementTypes.h"
#include "src/TargetTimes.h"
#include "src/RuntimeSettings.h"
#include "src/SensorManager.h"
#include "src/MeasurementEngine.h"
#include "src/DisplayManager.h"
#include "src/ButtonManager.h"
#include "src/WebServerManager.h"

SensorManager     sensorManager;
MeasurementEngine engine(sensorManager);
DisplayManager    displayManager;
ButtonManager     buttonManager;
WebServerManager  webServer;

enum class AppState : uint8_t {
  READY,
  MEASURING,
  RESULTS,
  MENU
};

AppState appState = AppState::READY;

int targetIndex = 0;
int targetFraction = DEFAULT_TARGET_TIME;
TargetSeries targetSeries = TargetSeries::Standard;
MeasurementMode measureMode = MeasurementMode::HORIZONTAL;
String resultDisplayMode = DEFAULT_RESULT_DISPLAY;
int oledSleepMinutes = DEFAULT_OLED_SLEEP_MINUTES;

bool oledSleeping = false;
bool suppressButtonsUntilReleased = false;
unsigned long lastUserActivity = 0;

bool displayDirty = true;
unsigned long lastDisplayUpdate = 0;
const unsigned long DISPLAY_REFRESH_MS = 100;

uint8_t resultPage = 1;
unsigned long resultUntil = 0;
unsigned long lastReadyArmAttempt = 0;
const unsigned long READY_ARM_RETRY_MS = 250;
MeasurementResult displayedResult;
DisplayResultSummary displayedSummary;
int displayedTargetFraction = DEFAULT_TARGET_TIME;
MeasurementMode displayedMode = MeasurementMode::HORIZONTAL;

uint8_t menuIndex = 0;
const uint8_t MENU_COUNT = 5;
RuntimeSettings menuDraft;
bool menuDirty = false;

void handleButtons();
void handleEngineState();
void runCriticalMeasurementLoop();
void refreshDisplay();
void setAppState(AppState next);
bool hasBlockingDeviceError();
bool isDeviceErrorVisibleOnOled();
bool checkLampConnectorBeforeLightOn();
void cycleMeasureMode();
void applyRuntimeSettings(bool resetSelection);
void applyUiSettings(const RuntimeSettings& cfg);
void applyTargetSettings(const RuntimeSettings& cfg, bool resetSelection);
void applySensorSettings(const RuntimeSettings& cfg);
bool recalibrateSensors(const char* reason);
bool calibrateSensorsFromApi();
void setDeviceError(DeviceError error, DeviceSubsystem subsystem);
void clearDeviceError(DeviceSubsystem subsystem = DeviceSubsystem::None);
bool hasDeviceError();
DeviceError currentDeviceError();
void handleWifiEvents();
void noteUserActivity();
void updateOledSleep();
bool areButtonsReleased();
bool enterReady();
bool startMeasurementFromCurrentSettings(bool noteActivity = true);
void maintainReadyCapture();
void closeResultsAndReady();
void openMenu();
void closeMenuAndReady();
void saveMenuDraftAndReady();
void handleMenuButtons(const ButtonEvents& ev);
void applyMenuSetting(uint8_t idx);
void buildMenuValues(const char* values[MENU_COUNT]);
void updateResultsTimeout();
void processNewResult();
String menuDraftJson();

// Initializes hardware, networking, settings, calibration, and the first ready capture.
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=============================="));
  Serial.println(F("     OpenCurtainLab ESP32"));
  Serial.println(F("=============================="));

  pinMode(PIN_LAMP_SENSE, INPUT_PULLUP);

  const bool displayOk = displayManager.begin();
  if (!displayOk) {
    webServer.setDeviceError(DeviceError::DisplayInitFailed, DeviceSubsystem::Display);
  }
  buttonManager.begin();
  sensorManager.begin();
  engine.setMode(measureMode);
  webServer.attachSensorManager(sensorManager);
  webServer.setCalibrationCallback(calibrateSensorsFromApi);

  webServer.begin(WIFI_CONNECT_TIMEOUT_MS);
  applyRuntimeSettings(true);
  webServer.consumeWifiEvent();

  Serial.printf("[Main] Target time: 1/%d s\n", targetFraction);
  Serial.printf("[Main] Mode: %s\n", measurementModeKey(measureMode));
  lastUserActivity = millis();
  enterReady();

  // Draw the first steady screen immediately so the splash is not left visible
  // until the next scheduler tick.
  refreshDisplay();
  displayDirty = false;
  lastDisplayUpdate = millis();
}

// Runs the main cooperative scheduler outside the critical capture loop.
void loop() {
  // Measurement time is handled first so the high-rate polling path cannot be delayed by UI or web work.
  if (appState == AppState::MEASURING) {
    runCriticalMeasurementLoop();
    handleEngineState();
    updateOledSleep();
    return;
  }

  // Settings can change from the WebUI; reapply them centrally and recalibrate sensors immediately.
  if (webServer.consumeSettingsChanged()) {
    applyRuntimeSettings(false);
    noteUserActivity();

    if (appState == AppState::MENU) {
      menuDraft = webServer.getSettings();
      menuDirty = false;
      displayDirty = true;
    } else {
      enterReady();
    }
  }

  // Normal cooperative work is only done outside the critical measuring window.
  handleButtons();
  maintainReadyCapture();

  if (appState == AppState::RESULTS) engine.update();

  // READY means the engine should stay armed unless a capture-blocking device error is active.
  if (!hasBlockingDeviceError() && appState == AppState::READY) {
    engine.update();
    if (engine.isCapturing()) {
      setAppState(AppState::MEASURING);
      runCriticalMeasurementLoop();
    }
  }

  handleEngineState();
  updateResultsTimeout();

  if (displayDirty && (millis() - lastDisplayUpdate) >= DISPLAY_REFRESH_MS) {
    refreshDisplay();
    displayDirty = false;
    lastDisplayUpdate = millis();
  }

  if (appState != AppState::MEASURING) {
    webServer.update();
    handleWifiEvents();
  }
  updateOledSleep();
}

// Keeps the sensor engine polling as fast as possible while a shutter event is being captured.
void runCriticalMeasurementLoop() {
  // Critical measurement loop: block non-measurement tasks until the shutter
  // event is finished. This maximizes sensor polling rate during the few
  // milliseconds that matter. A periodic yield keeps the watchdog safe if a
  // timeout measurement runs unusually long.
  uint16_t watchdogYieldCounter = 0;
  while (engine.isCapturing()) {
    engine.update();
    if (++watchdogYieldCounter == 0) delay(0);
  }
}

// Routes button events according to the current app state.
void handleButtons() {
  ButtonEvents ev = buttonManager.poll();

  // After the OLED wakes up, ignore held buttons until the user releases them to avoid accidental actions.
  if (suppressButtonsUntilReleased) {
    if (areButtonsReleased()) suppressButtonsUntilReleased = false;
    return;
  }

  if (ev.anyPressed()) {
    if (oledSleeping) {
      noteUserActivity();
      suppressButtonsUntilReleased = true;
      return;
    }
    noteUserActivity();
  }

  if (appState == AppState::MENU) {
    handleMenuButtons(ev);
    return;
  }

  // Result navigation is modal: buttons either change result page or return to READY.
  if (appState == AppState::RESULTS) {
    if (ev.listenPressed) {
      closeResultsAndReady();
      return;
    }

    if (ev.upPressed) {
      if (resultPage == 1) resultPage = 2;
      else closeResultsAndReady();
      displayDirty = true;
      return;
    }

    if (ev.downPressed) {
      if (resultPage == 2) resultPage = 1;
      else closeResultsAndReady();
      displayDirty = true;
      return;
    }
    return;
  }

  if (appState != AppState::READY) return;

  if (ev.listenPressed) {
    openMenu();
    return;
  }

  if (ev.upLongPressed) {
    cycleMeasureMode();
    return;
  }

  if (ev.upPressed && targetIndex < maxTargetIndex(targetSeries)) {
    targetIndex++;
    targetFraction = targetTimeAt(targetIndex, targetSeries);
    Serial.printf("[Main] Target time: 1/%d s\n", targetFraction);
    enterReady();
  }

  if (ev.downPressed && targetIndex > 0) {
    targetIndex--;
    targetFraction = targetTimeAt(targetIndex, targetSeries);
    Serial.printf("[Main] Target time: 1/%d s\n", targetFraction);
    enterReady();
  }
}

// Stops capture and opens the local OLED settings menu.
void openMenu() {
  Serial.println(F("[Main] Menu opened."));
  engine.cancel();
  setAppState(AppState::MENU);
  menuDraft = webServer.getSettings();
  menuDirty = false;
  menuIndex = 0;
  resultUntil = 0;
  displayDirty = true;
}

// Closes the menu without further changes and returns to ready mode.
void closeMenuAndReady() {
  menuDirty = false;
  enterReady();
}

// Persists pending menu changes, applies them, and returns to ready mode.
void saveMenuDraftAndReady() {
  if (menuDirty) {
    webServer.applySettingsJson(menuDraftJson());
    webServer.consumeSettingsChanged();
    applyRuntimeSettings(false);
  }
  closeMenuAndReady();
}

// Handles navigation and editing while the settings menu is open.
void handleMenuButtons(const ButtonEvents& ev) {
  if (ev.listenLongPressed) {
    saveMenuDraftAndReady();
    return;
  }
  if (ev.upPressed && menuIndex > 0) {
    menuIndex--;
    displayDirty = true;
    return;
  }
  if (ev.downPressed && menuIndex + 1 < MENU_COUNT) {
    menuIndex++;
    displayDirty = true;
    return;
  }
  if (ev.listenPressed) {
    applyMenuSetting(menuIndex);
    displayDirty = true;
  }
}

// Cycles the editable setting at the selected menu row.
void applyMenuSetting(uint8_t idx) {
  // Each menu row cycles through a small fixed set of values to keep local control simple.
  switch (idx) {
    case 0:
      if (menuDraft.sensorSensitivity == "medium") menuDraft.sensorSensitivity = "high";
      else if (menuDraft.sensorSensitivity == "high") menuDraft.sensorSensitivity = "low";
      else menuDraft.sensorSensitivity = "medium";
      menuDirty = true;
      break;

    case 1:
      menuDraft.targetSeries = nextTargetSeries(menuDraft.targetSeries);
      menuDirty = true;
      break;

    case 2:
      menuDraft.resultDisplayMode = nextResultDisplayMode(menuDraft.resultDisplayMode);
      menuDirty = true;
      break;

    case 3:
      if (menuDraft.oledSleepMinutes == 0) menuDraft.oledSleepMinutes = 1;
      else if (menuDraft.oledSleepMinutes == 1) menuDraft.oledSleepMinutes = 5;
      else if (menuDraft.oledSleepMinutes == 5) menuDraft.oledSleepMinutes = 10;
      else if (menuDraft.oledSleepMinutes == 10) menuDraft.oledSleepMinutes = 30;
      else menuDraft.oledSleepMinutes = 0;
      menuDirty = true;
      break;

    case 4:
      // Save pending menu changes before clearing WiFi so no local setting edits are lost.
      if (menuDirty) {
        webServer.applySettingsJson(menuDraftJson());
        webServer.consumeSettingsChanged();
        applyRuntimeSettings(false);
      }
      menuDirty = false;
      webServer.resetNetworkAndStartAp();
      enterReady();
      break;

    default:
      break;
  }
}

// Cycles the shutter travel mode and rearms the measurement engine.
void cycleMeasureMode() {
  measureMode = nextMeasurementMode(measureMode);
  engine.cancel();
  engine.setMode(measureMode);
  Serial.printf("[Main] Measurement direction: %s\n", measurementModeKey(measureMode));
  enterReady();
}

// Synchronizes the app state with the measurement engine state.
void handleEngineState() {
  if (engine.isCapturing()) {
    setAppState(AppState::MEASURING);
    return;
  }

  if (engine.hasNewResult()) processNewResult();
}

// Processes a newly finished capture exactly once and prepares the result screen and API data.
void processNewResult() {
  // The API keeps raw timestamps plus validity/hints; derived exposure values are prepared only for the OLED.
  engine.calculateResults(targetFraction);

  webServer.setLastResult(engine.getResult(), targetFraction, measureMode);

  noteUserActivity();
  Serial.printf("[Main] Result: avg 1/%d s  (%+.2f EV), Mode %s, hint=%s\n",
                engine.getSummary().avgFraction,
                engine.getSummary().avgDeviationStops,
                measurementModeKey(measureMode),
                measurementHintKey(engine.getResult().hint));

  // Copy the finished result before marking it handled so display and API state stay stable.
  displayedResult = engine.getResult();
  displayedSummary = engine.getSummary();
  displayedTargetFraction = targetFraction;
  displayedMode = measureMode;
  resultPage = 1;
  engine.markResultHandled();

  if (resultDisplayMode == "none") {
    enterReady();
    return;
  }

  setAppState(AppState::RESULTS);
  const unsigned long durationMs = resultDisplayDurationMs(resultDisplayMode);
  resultUntil = durationMs > 0 ? millis() + durationMs : 0;
  displayDirty = true;
}

// Applies stored settings to UI state, target selection, sensors, and the engine.
void applyRuntimeSettings(bool resetSelection) {
  const RuntimeSettings& cfg = webServer.getSettings();

  // Apply settings in separated domains so future changes remain localized.
  applyUiSettings(cfg);
  applyTargetSettings(cfg, resetSelection);
  applySensorSettings(cfg);

  engine.setMode(measureMode);
  Serial.printf("[Settings] mode=%s max=1/%d default=1/%d series=%s sensitivity=%s resultDisplay=%s\n",
                measurementModeKey(cfg.defaultMode), DEVICE_MAX_TARGET_TIME, cfg.defaultTargetTime,
                targetSeriesKey(cfg.targetSeries), cfg.sensorSensitivity.c_str(), cfg.resultDisplayMode.c_str());

  // Threshold or input-mode changes affect baselines, so every settings application recalibrates sensors.
  recalibrateSensors(resetSelection ? "startup/settings" : "settings");
  displayDirty = true;
}

// Copies display-related settings into runtime variables.
void applyUiSettings(const RuntimeSettings& cfg) {
  resultDisplayMode = cfg.resultDisplayMode;
  oledSleepMinutes = cfg.oledSleepMinutes;
}

// Selects the active target-time series and current target index.
void applyTargetSettings(const RuntimeSettings& cfg, bool resetSelection) {
  targetSeries = cfg.targetSeries;
  if (resetSelection) {
    measureMode = cfg.defaultMode;
    targetIndex = targetIndexForTime(cfg.defaultTargetTime, targetSeries);
  } else {
    targetIndex = targetIndexForTime(targetFraction, targetSeries);
  }
  targetFraction = targetTimeAt(targetIndex, targetSeries);
}

// Applies the configured sensor read mode and ADC thresholds.
void applySensorSettings(const RuntimeSettings& cfg) {
  sensorManager.setSensorThresholds(cfg.sensorOnDelta(), cfg.sensorOffDelta());
}


// Changes the user-visible app state and schedules a redraw when it changes.
void setAppState(AppState next) {
  if (appState == next) return;
  appState = next;
  displayDirty = true;
}

// Returns true only for device errors that should block measurement capture before a new start attempt.
bool hasBlockingDeviceError() {
  const DeviceError err = currentDeviceError();
  return err != DeviceError::None
      && err != DeviceError::LampConnectorMiswired;
}

// Returns true when the current device error can be shown on the OLED ready screen.
bool isDeviceErrorVisibleOnOled() {
  const DeviceError err = currentDeviceError();
  return err != DeviceError::None && err != DeviceError::DisplayInitFailed;
}

// Checks the lamp jack sense line immediately before enabling the lamp output.
bool checkLampConnectorBeforeLightOn() {
  if (digitalRead(PIN_LAMP_SENSE) == LOW) {
    if (currentDeviceError() != DeviceError::LampConnectorMiswired) {
      setDeviceError(DeviceError::LampConnectorMiswired, DeviceSubsystem::Lamp);
      Serial.println(F("[Lamp] Device error: lamp connector sense line is low. Lamp output remains off."));
    } else {
      displayDirty = true;
    }
    return false;
  }

  clearDeviceError(DeviceSubsystem::Lamp);
  return true;
}

// Recalibrates all sensor baselines and updates the device error state.
bool recalibrateSensors(const char* reason) {
  Serial.printf("[Sensors] Calibrating baselines after %s...\n", reason ? reason : "settings");
  if (!sensorManager.calibrateBaseline()) {
    setDeviceError(DeviceError::SensorBaselineTooLow, DeviceSubsystem::Sensor);
    Serial.println(F("[Sensors] Device error: sensor baseline too low."));
    return false;
  }

  clearDeviceError(DeviceSubsystem::Sensor);
  Serial.println(F("[Sensors] Baseline calibration OK."));
  return true;
}

// Runs sensor calibration from the HTTP API and returns the device to ready capture.
bool calibrateSensorsFromApi() {
  Serial.println(F("[Sensors] Calibration requested through API."));
  engine.cancel();
  const bool ok = recalibrateSensors("api");
  noteUserActivity();
  enterReady();
  return ok;
}

// Sets a capture-blocking device error and makes sure no capture continues.
void setDeviceError(DeviceError error, DeviceSubsystem subsystem) {
  webServer.setDeviceError(error, subsystem);
  if (error != DeviceError::None) {
    engine.cancel();
    setAppState(AppState::READY);
    resultUntil = 0;
  }
  displayDirty = true;
}

// Clears a device error globally or only for a specific subsystem.
void clearDeviceError(DeviceSubsystem subsystem) {
  const bool hadError = hasDeviceError();
  webServer.clearDeviceError(subsystem);

  if (hadError || hasDeviceError()) displayDirty = true;
}

// Returns whether any device error is currently reported through the status API.
bool hasDeviceError() {
  return currentDeviceError() != DeviceError::None;
}

// Returns the current device error from the web/status owner.
DeviceError currentDeviceError() {
  return webServer.getDeviceError();
}

// Returns the app to ready mode and tries to arm the capture engine.
bool enterReady() {
  resultUntil = 0;
  resultPage = 1;
  setAppState(AppState::READY);

  if (hasBlockingDeviceError()) {
    engine.cancel();
    displayDirty = true;
    return false;
  }

  return startMeasurementFromCurrentSettings();
}

// Starts listening with the current target and measurement mode.
bool startMeasurementFromCurrentSettings(bool noteActivity) {
  if (noteActivity) noteUserActivity();
  lastReadyArmAttempt = millis();
  if (!checkLampConnectorBeforeLightOn()) {
    displayDirty = true;
    return false;
  }
  if (!engine.startListening(measureMode)) {
    displayDirty = true;
    return false;
  }
  displayDirty = true;
  return true;
}

// Retries arming while ready if a temporary start hint previously prevented arming.
void maintainReadyCapture() {
  if (appState != AppState::READY || hasBlockingDeviceError()) return;
  if (engine.isArmed() || engine.isCapturing() || engine.hasNewResult()) return;
  if ((millis() - lastReadyArmAttempt) < READY_ARM_RETRY_MS) return;
  startMeasurementFromCurrentSettings(false);
}

// Leaves the result screen and returns to ready mode.
void closeResultsAndReady() {
  enterReady();
}

// Closes the result screen when the selected display timeout has elapsed.
void updateResultsTimeout() {
  if (appState != AppState::RESULTS || resultUntil == 0) return;
  if (millis() >= resultUntil) closeResultsAndReady();
}

// Marks the display dirty when WiFi state changes need to be reflected.
void handleWifiEvents() {
  const WifiEvent ev = webServer.consumeWifiEvent();
  if (ev != WifiEvent::None) displayDirty = true;
}

// Records user activity and wakes the OLED if it was sleeping.
void noteUserActivity() {
  lastUserActivity = millis();
  if (oledSleeping) {
    displayManager.wake();
    oledSleeping = false;
    Serial.println(F("[Display] OLED wake"));
    displayDirty = true;
  }
}

// Checks whether all physical buttons have been released.
bool areButtonsReleased() {
  return digitalRead(PIN_BTN_LISTEN) == HIGH
      && digitalRead(PIN_BTN_UP) == HIGH
      && digitalRead(PIN_BTN_DOWN) == HIGH;
}

// Turns off the OLED after the configured inactivity timeout.
void updateOledSleep() {
  if (oledSleepMinutes <= 0 || oledSleeping) return;
  const unsigned long sleepMs = (unsigned long)oledSleepMinutes * 60000UL;
  if (sleepMs > 0 && millis() - lastUserActivity >= sleepMs) {
    displayManager.sleep();
    oledSleeping = true;
    Serial.println(F("[Display] OLED sleep"));
  }
}

// Builds the short value strings shown beside each menu entry.
void buildMenuValues(const char* values[MENU_COUNT]) {
  static char sens[10];
  static char series[10];
  static char results[12];
  static char sleep[8];
  const RuntimeSettings& cfg = appState == AppState::MENU ? menuDraft : webServer.getSettings();
  strncpy(sens, cfg.sensorSensitivity.c_str(), sizeof(sens) - 1); sens[sizeof(sens)-1] = '\0';
  strncpy(series, targetSeriesKey(cfg.targetSeries), sizeof(series) - 1); series[sizeof(series)-1] = '\0';
  snprintf(results, sizeof(results), "%s", resultDisplayLabel(cfg.resultDisplayMode));
  if (cfg.oledSleepMinutes <= 0) snprintf(sleep, sizeof(sleep), "Off");
  else snprintf(sleep, sizeof(sleep), "%d min", cfg.oledSleepMinutes);
  values[0] = sens;
  values[1] = series;
  values[2] = results;
  values[3] = sleep;
  values[4] = nullptr;
}

// Serializes the current menu draft into the same JSON accepted by /config.
String menuDraftJson() {
  StaticJsonDocument<768> doc;
  doc["defaultMeasurementMode"] = measurementModeKey(menuDraft.defaultMode);
  doc["defaultTargetTime"] = menuDraft.defaultTargetTime;
  doc["sensorSensitivity"] = menuDraft.sensorSensitivity;
  doc["resultDisplay"] = menuDraft.resultDisplayMode;
  doc["targetSeries"] = targetSeriesKey(menuDraft.targetSeries);
  JsonArray custom = doc.createNestedArray("customTargetTimes");
  for (int i = 0; i < menuDraft.customTargetTimesCount && i < TARGET_TIMES_MAX_COUNT; i++) custom.add(menuDraft.customTargetTimes[i]);
  doc["oledSleepMinutes"] = menuDraft.oledSleepMinutes;
  String out;
  serializeJson(doc, out);
  return out;
}

// Redraws the OLED for the current app state.
void refreshDisplay() {
  if (oledSleeping) return;

  // Only the four user-visible app states draw screens
  switch (appState) {
    case AppState::READY: {
      const String net = webServer.getNetworkLine();
      const DeviceError displayError = isDeviceErrorVisibleOnOled() ? currentDeviceError() : DeviceError::None;
      displayManager.showReady(targetFraction, measureMode, net, displayError, engine.getReadyHint());
      break;
    }

    case AppState::MEASURING:
      return;

    case AppState::RESULTS:
      displayManager.showResult(displayedResult, displayedSummary, displayedTargetFraction, displayedMode, resultPage);
      break;

    case AppState::MENU: {
      static const char* labels[MENU_COUNT] = { "Sensitivity", "Time series", "Results", "OLED sleep", "Reset network" };
      const char* values[MENU_COUNT] = { nullptr, nullptr, nullptr, nullptr, nullptr };
      buildMenuValues(values);
      displayManager.showMenu(menuIndex, labels, values, MENU_COUNT);
      break;
    }
  }
}
