/*
 * Hosts the HTTP API, setup portal routes, runtime settings endpoint, WiFi endpoint, and last measurement data.
 */

#pragma once
#include <Arduino.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "Config.h"
#include "RuntimeSettings.h"
#include "MeasurementTypes.h"
#include "SensorManager.h"
#include "WifiProvisioning.h"
#include "JsonBuilder.h"
#include "SetupPortalHtml.h"

class WebServerManager {
public:
  // Constructs the HTTP server on port 80.
  WebServerManager() : _server(80) {}

  // WiFi/AP must be initialized before WebServer::begin()
  // Starting the server first can trip an ESP32 core assertion
  // Initializes settings, WiFi provisioning, routes, and the HTTP server.
  bool begin(unsigned long timeoutMs = WIFI_CONNECT_TIMEOUT_MS) {
    _settings.begin();
    _wifi.beginPreferences();

    const bool stationConnected = _wifi.connectStation(timeoutMs);
    syncNetworkDeviceStatus();

    setupRoutes();
    _server.begin();
    _serverStarted = true;
    Serial.println(F("[Web] HTTP server started."));
    return stationConnected;
  }

  // Updates WiFi provisioning and handles pending HTTP clients.
  void update() {
    _wifi.update();
    syncNetworkDeviceStatus();
    if (_serverStarted) _server.handleClient();
  }

  // Starts the setup access point manually.
  void startAccessPointMode() { _wifi.startAccessPointMode(); syncNetworkDeviceStatus(); }
  // Clears saved WiFi credentials and starts the setup access point.
  void resetNetworkAndStartAp() { _wifi.resetNetworkAndStartAp(); syncNetworkDeviceStatus(); }

  // Stores the latest raw result and assigns a new measurement id.
  void setLastResult(const MeasurementResult& result, int targetFraction, MeasurementMode mode) {
    _result = result;
    _targetFraction = targetFraction;
    _mode = mode;
    _measurementId++;
    snprintf(_measIdStr, sizeof(_measIdStr), "m_%lu_%lu", millis(), (unsigned long)_measurementId);
  }

  // Stores the device-level error for /status.
  void setDeviceError(DeviceError error, DeviceSubsystem subsystem) { _deviceStatus = { error, subsystem }; }
  // Clears the device-level error globally or only when it belongs to the requested subsystem.
  void clearDeviceError(DeviceSubsystem subsystem = DeviceSubsystem::None) {
    if (subsystem != DeviceSubsystem::None && _deviceStatus.subsystem != subsystem) {
      syncNetworkDeviceStatus();
      return;
    }
    _deviceStatus = _wifi.deviceStatus();
  }
  // Returns the device-level error reported by /status.
  DeviceError getDeviceError() const { return _deviceStatus.error; }
  // Returns the subsystem owning the current device-level error.
  DeviceSubsystem getDeviceSubsystem() const { return _deviceStatus.subsystem; }
  // Returns the full device status.
  DeviceStatus getDeviceStatus() const { return _deviceStatus; }


  // Returns whether station WiFi is connected.
  bool isConnected() const { return _wifi.isConnected(); }
  // Returns whether the setup access point is active.
  bool isAccessPointMode() const { return _wifi.isAccessPointMode(); }
  // Returns the currently relevant station or AP IP address.
  String getIP() const { return _wifi.ip(); }
  // Returns a compact network label for the OLED ready screen.
  String getNetworkLine() const { return _wifi.networkLine(); }
  // Returns and clears the latest WiFi event.
  WifiEvent consumeWifiEvent() { return _wifi.consumeEvent(); }

  // Returns the current sanitized runtime settings.
  const RuntimeSettings& getSettings() const { return _settings.get(); }
  // Applies settings JSON and records that the runtime needs to refresh settings.
  bool applySettingsJson(const String& body) { const bool changed = _settings.applyJson(body); if (changed) _settingsChanged = true; return changed; }
  // Returns and clears the settings-changed flag.
  bool consumeSettingsChanged() { const bool v = _settingsChanged; _settingsChanged = false; return v; }

  // Attaches the hardware sensor manager used by /sensors diagnostics.
  void attachSensorManager(SensorManager& sensors) { _sensorManager = &sensors; }

  // Attaches an app-level calibration callback used by POST /calibrate.
  void setCalibrationCallback(bool (*callback)()) { _calibrationCallback = callback; }

private:
  WebServer _server;
  WifiProvisioning _wifi;
  RuntimeSettingsStore _settings;
  bool _serverStarted = false;
  bool _settingsChanged = false;

  MeasurementResult _result;
  int _targetFraction = DEFAULT_TARGET_TIME;
  MeasurementMode _mode = MeasurementMode::LEFT;
  uint32_t _measurementId = 0;
  char _measIdStr[32] = "";
  DeviceStatus _deviceStatus;
  SensorManager* _sensorManager = nullptr;
  bool (*_calibrationCallback)() = nullptr;

  // Adds CORS and no-cache headers to API responses.
  void cors() {
    _server.sendHeader("Access-Control-Allow-Origin", "*");
    _server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    _server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
    _server.sendHeader("Access-Control-Allow-Private-Network", "true");
    _server.sendHeader("Cache-Control", "no-cache");
  }

  // Sends a JSON response with standard API headers.
  void sendJson(int code, const String& json) {
    cors();
    _server.send(code, "application/json", json);
  }

  // Builds a simple JSON error response.
  String jsonError(const char* error, bool ok = false) const {
    StaticJsonDocument<160> doc;
    doc["ok"] = ok;
    doc["error"] = error ? error : "error";
    String out;
    serializeJson(doc, out);
    return out;
  }

  // Serves the embedded gzip-compressed WiFi setup portal HTML.
  void serveSetupPage() {
    _server.sendHeader("Cache-Control", "no-cache");
    _server.sendHeader("Content-Encoding", "gzip");
    _server.sendHeader("Vary", "Accept-Encoding");
    _server.send_P(200, "text/html", reinterpret_cast<const char*>(SETUP_PORTAL_HTML_GZ), SETUP_PORTAL_HTML_GZ_LEN);
  }

  // Redirects browser requests to the raw single-file WebUI when proxying is unavailable.
  void redirectToWebApp() {
    cors();
    _server.sendHeader("Location", WEB_APP_URL);
    _server.send(302, "text/plain", "OpenCurtainLab Web UI");
  }

  // Streams the remote single-file WebUI through the ESP32.
  // The page is not persisted on the ESP32; data is copied from the HTTPS response to the HTTP client in small chunks.
  bool proxyRemoteWebApp() {
    if (!_wifi.isConnected()) return false;

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(WEB_APP_PROXY_TIMEOUT_MS);
    http.useHTTP10(false);

    Serial.printf("[Web] Proxying WebUI: %s\n", WEB_APP_URL);
    if (!http.begin(client, WEB_APP_URL)) {
      Serial.println(F("[Web] WebUI proxy begin failed."));
      http.end();
      return false;
    }

    http.addHeader("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    http.addHeader("User-Agent", "OpenCurtainLab ESP32");
    const int code = http.GET();
    if (code != HTTP_CODE_OK) {
      Serial.printf("[Web] WebUI proxy GET failed: %d\n", code);
      http.end();
      return false;
    }

    WiFiClient* input = http.getStreamPtr();
    WiFiClient output = _server.client();
    uint8_t buffer[WEB_APP_PROXY_CHUNK_SIZE];

    // Send a plain close-delimited HTTP response. This avoids buffering the full file and avoids chunk framing.
    output.print(F("HTTP/1.1 200 OK\r\n"));
    output.print(F("Content-Type: text/html; charset=utf-8\r\n"));
    output.print(F("Cache-Control: no-cache\r\n"));
    output.print(F("X-OpenCurtainLab-Source: remote-proxy\r\n"));
    output.print(F("Connection: close\r\n"));
    output.print(F("\r\n"));

    unsigned long lastDataMs = millis();
    while (http.connected() && output.connected()) {
      const size_t available = input->available();
      if (available) {
        const size_t want = available < sizeof(buffer) ? available : sizeof(buffer);
        const int readLen = input->readBytes(buffer, want);
        if (readLen > 0) {
          output.write(buffer, readLen);
          lastDataMs = millis();
        }
      } else {
        if (millis() - lastDataMs > WEB_APP_PROXY_IDLE_TIMEOUT_MS) break;
        delay(1);
      }
    }

    output.flush();
    output.stop();
    http.end();
    return true;
  }


  // Serves the remote WebUI through the ESP32 and falls back to the raw file URL when proxying fails.
  void serveWebApp() {
    if (!proxyRemoteWebApp()) redirectToWebApp();
  }

  // Serves the setup portal in AP mode. In station mode, root serves the proxied WebUI.
  void serveRootLikePage() {
    if (_wifi.isAccessPointMode()) {
      serveSetupPage();
      return;
    }
    serveWebApp();
  }

  // Registers API, setup portal, captive portal, and CORS routes.
  void setupRoutes() {
    // Root opens the setup page in AP mode or serves the proxied WebUI in station mode.
    _server.on("/", HTTP_GET, [this]() { serveRootLikePage(); });

    // Common captive-portal probe paths are routed to the same setup/redirect behavior as root.
    const char* captivePaths[] = { "/generate_204", "/hotspot-detect.html", "/fwlink", "/connecttest.txt", "/ncsi.txt" };
    for (const char* path : captivePaths) {
      // Captive portal probes use the same setup/redirect behavior as root.
      _server.on(path, HTTP_GET, [this]() { serveRootLikePage(); });
    }

    // Every API route gets an explicit OPTIONS handler for browser-based WebUIs.
    registerOptions("/data");
    registerOptions("/status");
    registerOptions("/config");
    registerOptions("/sensors");
    registerOptions("/calibrate");
    registerOptions("/wifi");
    registerOptions("/wifi/scan");
    registerOptions("/wifi/status");

    // Core API routes are read-only except /config and /wifi.
    // /status reports device, WiFi, uptime, measurement count, and device-level error.
    _server.on("/status", HTTP_GET, [this]() { sendJson(200, buildStatusJson()); });
    // GET /config reports firmware capabilities and sanitized runtime settings.
    _server.on("/config", HTTP_GET, [this]() { sendJson(200, JsonBuilder::config(_settings.get())); });
    // /data returns the latest raw measurement for WebUI-side calculation.
    _server.on("/data", HTTP_GET, [this]() { sendJson(200, JsonBuilder::data(_result, _measurementId, _measIdStr, _targetFraction, _mode)); });
    // /sensors returns live non-mutating sensor diagnostics for developer tools.
    _server.on("/sensors", HTTP_GET, [this]() { handleSensorsGet(); });
    // POST /calibrate recalibrates sensor baselines through the app-level callback.
    _server.on("/calibrate", HTTP_POST, [this]() { handleCalibratePost(); });
    // POST /config accepts partial settings updates.
    _server.on("/config", HTTP_POST, [this]() { handleConfigPost(); });
    // POST /wifi tests and stores WiFi credentials.
    _server.on("/wifi", HTTP_POST, [this]() { handleWifiPost(); });
    // /wifi/scan returns nearby networks for the setup portal.
    _server.on("/wifi/scan", HTTP_GET, [this]() { sendJson(200, _wifi.scanJson()); });
    // /wifi/status returns provisioning state for the setup portal.
    _server.on("/wifi/status", HTTP_GET, [this]() { sendJson(200, buildWifiStatusJson()); });

    // Unknown paths serve the captive portal in AP mode and a JSON error otherwise.
    _server.onNotFound([this]() {
      if (_wifi.isAccessPointMode()) serveSetupPage();
      else sendJson(404, jsonError("not found"));
    });
  }

  // Registers one CORS preflight handler.
  void registerOptions(const char* path) {
    // Preflight responses are intentionally empty but include CORS headers.
    _server.on(path, HTTP_OPTIONS, [this]() { cors(); _server.send(204); });
  }


  // Mirrors hard network failures into the central device status without overwriting higher-priority subsystem errors.
  void syncNetworkDeviceStatus() {
    const DeviceStatus networkStatus = _wifi.deviceStatus();
    if (networkStatus.hasError()) {
      if (!_deviceStatus.hasError() || _deviceStatus.subsystem == DeviceSubsystem::Network) {
        _deviceStatus = networkStatus;
      }
      return;
    }

    if (_deviceStatus.subsystem == DeviceSubsystem::Network) {
      _deviceStatus = DeviceStatus();
    }
  }

  // Builds the WiFi status JSON response used by the setup page.
  String buildWifiStatusJson(bool ok = true) const {
    StaticJsonDocument<768> doc;
    const NetworkHint hint = _wifi.networkHint();
    doc["ok"] = ok;
    doc["connected"] = _wifi.isConnected();
    doc["apMode"] = _wifi.isAccessPointMode();
    doc["ip"] = _wifi.staIp();
    doc["apIp"] = _wifi.apIp();
    doc["hostname"] = _wifi.hostname();
    doc["mdnsStarted"] = _wifi.isMdnsStarted();
    doc["hasSaved"] = _wifi.hasStoredCredentials();
    doc["savedSsid"] = _wifi.savedSsid();
    doc["currentSsid"] = _wifi.currentSsid();
    doc["hint"] = networkHintKey(hint);
    doc["hintText"] = networkHintText(hint);
    doc["lastError"] = _wifi.lastWifiError();

    String out;
    serializeJson(doc, out);
    return out;
  }

  // Builds the device status JSON response.
  String buildStatusJson() const {
    DeviceStatusView view;
    view.connected = _wifi.isConnected();
    view.apMode = _wifi.isAccessPointMode();
    view.mdnsStarted = _wifi.isMdnsStarted();
    view.ip = _wifi.ip();
    view.apIp = _wifi.apIp();
    view.hostname = _wifi.hostname();
    view.mdns = _wifi.hostname() + String(".local");
    view.savedSsid = _wifi.savedSsid();
    view.currentSsid = _wifi.currentSsid();
    view.measurementId = _measurementId;
    view.deviceStatus = _deviceStatus;
    view.networkHint = _wifi.networkHint();
    return JsonBuilder::status(view);
  }

  // Handles GET /sensors and returns a live sensor diagnostics snapshot.
  void handleSensorsGet() {
    if (!_sensorManager) {
      sendJson(503, jsonError("sensors unavailable"));
      return;
    }
    sendJson(200, JsonBuilder::sensors(*_sensorManager));
  }

  // Handles POST /calibrate and runs the app-level calibration callback.
  void handleCalibratePost() {
    if (!_calibrationCallback) {
      sendJson(503, jsonError("calibration unavailable"));
      return;
    }

    const bool ok = _calibrationCallback();
    StaticJsonDocument<320> doc;
    doc["ok"] = ok;
    doc["calibrated"] = ok;
    if (_sensorManager) {
      JsonArray baselines = doc.createNestedArray("baselines");
      for (int i = 0; i < SENSOR_COUNT; i++) baselines.add(_sensorManager->getSensor(i).baselineValue);
    }
    if (!ok) doc["error"] = "calibration failed";

    String resp;
    serializeJson(doc, resp);
    sendJson(ok ? 200 : 500, resp);
  }

  // Handles POST /config and returns the sanitized settings.
  void handleConfigPost() {
    if (!_server.hasArg("plain") || !_server.arg("plain").length()) {
      sendJson(400, jsonError("missing_body"));
      return;
    }

    const String body = _server.arg("plain");
    StaticJsonDocument<1024> validation;
    DeserializationError err = deserializeJson(validation, body);
    if (err) {
      sendJson(400, jsonError("invalid_json"));
      return;
    }

    const bool changed = _settings.applyJson(body);
    if (changed) _settingsChanged = true;

    StaticJsonDocument<1024> doc;
    doc["ok"] = true;
    doc["changed"] = changed;
    JsonObject settings = doc.createNestedObject("settings");
    JsonBuilder::appendSettings(settings, _settings.get());

    String resp;
    serializeJson(doc, resp);
    sendJson(200, resp);
  }

  // Handles POST /wifi from JSON or form data and tests the credentials.
  void handleWifiPost() {
    String ssid = _server.arg("ssid");
    String pass = _server.arg("password");

    // The setup page posts JSON, while simple tools may submit form fields.
    if (!ssid.length() && _server.hasArg("plain")) {
      StaticJsonDocument<384> doc;
      if (!deserializeJson(doc, _server.arg("plain"))) {
        ssid = String(doc["ssid"] | "");
        pass = String(doc["password"] | "");
      }
    }

    if (!ssid.length()) {
      sendJson(400, jsonError("ssid missing"));
      return;
    }

    // Credentials are only saved by WifiProvisioning when the connection test succeeds.
    const bool connected = _wifi.connectWithCredentials(ssid, pass, WIFI_CONNECT_TIMEOUT_MS);
    syncNetworkDeviceStatus();
    StaticJsonDocument<768> doc;
    const NetworkHint hint = _wifi.networkHint();
    doc["ok"] = connected;
    doc["connected"] = _wifi.isConnected();
    doc["apMode"] = _wifi.isAccessPointMode();
    doc["ip"] = _wifi.staIp();
    doc["apIp"] = _wifi.apIp();
    doc["hostname"] = _wifi.hostname();
    doc["mdnsStarted"] = _wifi.isMdnsStarted();
    doc["hasSaved"] = _wifi.hasStoredCredentials();
    doc["savedSsid"] = _wifi.savedSsid();
    doc["currentSsid"] = _wifi.currentSsid();
    doc["hint"] = networkHintKey(hint);
    doc["hintText"] = networkHintText(hint);
    doc["lastError"] = _wifi.lastWifiError();
    if (!connected) doc["error"] = "connection failed";

    String resp;
    serializeJson(doc, resp);
    sendJson(200, resp);
  }

};
