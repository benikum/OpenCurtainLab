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
  // Returns the current user-facing network diagnostic hint.
  NetworkHint getNetworkHint() const { return _wifi.networkHint(); }
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

private:
  WebServer _server;
  WifiProvisioning _wifi;
  RuntimeSettingsStore _settings;
  bool _serverStarted = false;
  bool _settingsChanged = false;

  MeasurementResult _result;
  int _targetFraction = DEFAULT_TARGET_TIME;
  MeasurementMode _mode = MeasurementMode::HORIZONTAL;
  uint32_t _measurementId = 0;
  char _measIdStr[32] = "";
  DeviceStatus _deviceStatus;
  SensorManager* _sensorManager = nullptr;

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

  // Serves the embedded gzip-compressed WiFi setup portal HTML.
  void serveSetupPage() {
    _server.sendHeader("Cache-Control", "no-cache");
    _server.sendHeader("Content-Encoding", "gzip");
    _server.sendHeader("Vary", "Accept-Encoding");
    _server.send_P(200, "text/html", reinterpret_cast<const char*>(SETUP_PORTAL_HTML_GZ), SETUP_PORTAL_HTML_GZ_LEN);
  }

  struct OclVersionParts {
    int major = -1;
    int api = -1;
    int patch = -1;
    bool wildcardPatch = false;
    bool valid = false;
  };

  struct WebUiRelease {
    String match;
    String version;
    String url;
    bool valid = false;
  };

  // Parses either an exact OpenCurtainLab version such as 0.1.3 or a patch wildcard such as 0.1.x.
  static bool parseOclVersion(const String& value, OclVersionParts& out) {
    String v = value;
    v.trim();
    out = OclVersionParts();
    if (!v.length()) return false;

    const int firstDot = v.indexOf('.');
    if (firstDot <= 0) return false;
    const int secondDot = v.indexOf('.', firstDot + 1);
    if (secondDot <= firstDot + 1) return false;

    const String majorPart = v.substring(0, firstDot);
    const String apiPart = v.substring(firstDot + 1, secondDot);
    String patchPart = v.substring(secondDot + 1);
    patchPart.trim();

    if (!parseNonNegativeInt(majorPart, out.major)) return false;
    if (!parseNonNegativeInt(apiPart, out.api)) return false;

    if (patchPart == "x" || patchPart == "X" || patchPart == "*") {
      out.patch = -1;
      out.wildcardPatch = true;
      out.valid = true;
      return true;
    }

    int patchEnd = 0;
    while (patchEnd < static_cast<int>(patchPart.length()) && isDigit(patchPart.charAt(patchEnd))) patchEnd++;
    if (patchEnd <= 0) return false;
    if (patchEnd < static_cast<int>(patchPart.length())) {
      const char suffixMarker = patchPart.charAt(patchEnd);
      if (suffixMarker != '-' && suffixMarker != '+') return false;
    }

    String numericPatch = patchPart.substring(0, patchEnd);
    if (!parseNonNegativeInt(numericPatch, out.patch)) return false;
    out.valid = true;
    return true;
  }

  // Parses only non-negative integer strings so values like "1abc" do not pass as 1.
  static bool parseNonNegativeInt(const String& value, int& out) {
    if (!value.length()) return false;
    long result = 0;
    for (size_t i = 0; i < value.length(); i++) {
      const char c = value.charAt(i);
      if (!isDigit(c)) return false;
      result = result * 10 + (c - '0');
      if (result > 32767) return false;
    }
    out = static_cast<int>(result);
    return true;
  }

  // Returns whether a manifest match pattern is compatible with this firmware version.
  static bool versionPatternMatches(const OclVersionParts& pattern, const OclVersionParts& firmware) {
    if (!pattern.valid || !firmware.valid) return false;
    if (pattern.major != firmware.major) return false;
    if (pattern.api != firmware.api) return false;
    if (pattern.wildcardPatch) return true;
    return pattern.patch == firmware.patch;
  }

  // Compares exact versions that already share major and API. Returns true when candidate is newer than current.
  static bool isNewerBugfix(const OclVersionParts& candidate, const OclVersionParts& current) {
    if (!candidate.valid || !current.valid) return false;
    return candidate.patch > current.patch;
  }

  // Fetches web/manifest.json and selects the newest bugfix WebUI compatible with this firmware's API version.
  bool resolveWebUiRelease(WebUiRelease& selected) {
    selected = WebUiRelease();
    if (!_wifi.isConnected()) return false;

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(WEB_MANIFEST_TIMEOUT_MS);

    Serial.printf("[Web] Fetching WebUI manifest: %s\n", WEB_MANIFEST_URL);
    if (!http.begin(client, WEB_MANIFEST_URL)) {
      Serial.println(F("[Web] Manifest begin failed."));
      http.end();
      return false;
    }

    http.addHeader("Accept", "application/json,text/plain,*/*;q=0.8");
    http.addHeader("User-Agent", "OpenCurtainLab ESP32");
    const int code = http.GET();
    if (code != HTTP_CODE_OK) {
      Serial.printf("[Web] Manifest GET failed: %d\n", code);
      http.end();
      return false;
    }

    const String body = http.getString();
    http.end();

    DynamicJsonDocument doc(8192);
    DeserializationError err = deserializeJson(doc, body);
    if (err) {
      Serial.printf("[Web] Manifest JSON parse failed: %s\n", err.c_str());
      return false;
    }

    JsonArray entries = doc["entries"].as<JsonArray>();
    if (entries.isNull()) {
      Serial.println(F("[Web] Manifest has no entries array."));
      return false;
    }

    OclVersionParts firmwareVersion;
    if (!parseOclVersion(String(FIRMWARE_VERSION), firmwareVersion)) {
      Serial.println(F("[Web] Firmware version could not be parsed."));
      return false;
    }

    WebUiRelease best;
    OclVersionParts bestVersion;

    for (JsonObject entry : entries) {
      const char* matchC = entry["match"] | "";
      if (!matchC || !matchC[0]) matchC = entry["firmware"] | "";
      const String match = String(matchC ? matchC : "");
      String actualVersion = String(entry["version"] | "");
      const String url = String(entry["url"] | "");
      if (!match.length() || !url.length() || !actualVersion.length()) continue;
      OclVersionParts matchVersion;
      OclVersionParts releaseVersion;
      if (!parseOclVersion(match, matchVersion)) continue;
      if (!parseOclVersion(actualVersion, releaseVersion)) continue;
      if (!versionPatternMatches(matchVersion, firmwareVersion)) continue;
      if (releaseVersion.major != firmwareVersion.major || releaseVersion.api != firmwareVersion.api) continue;

      if (!best.valid || isNewerBugfix(releaseVersion, bestVersion)) {
        best.match = match;
        best.version = actualVersion;
        best.url = url;
        best.valid = true;
        bestVersion = releaseVersion;
      }
    }

    if (!best.valid) {
      Serial.println(F("[Web] No compatible WebUI release found in manifest."));
      return false;
    }

    selected = best;
    Serial.printf("[Web] Selected WebUI %s for firmware %s via %s\n", selected.version.c_str(), FIRMWARE_VERSION, selected.match.c_str());
    return true;
  }

  // Returns the selected remote WebUI version as plain text. Used by the WebUI update check.
  void serveVersion() {
    WebUiRelease release;
    if (resolveWebUiRelease(release)) {
      cors();
      _server.sendHeader("X-OpenCurtainLab-Version-Source", "manifest");
      _server.sendHeader("X-OpenCurtainLab-WebUI-Match", release.match);
      _server.send(200, "text/plain; charset=utf-8", release.version);
      return;
    }

    cors();
    _server.sendHeader("X-OpenCurtainLab-Version-Source", "local-fallback");
    _server.send(200, "text/plain; charset=utf-8", FIRMWARE_VERSION);
  }

  // Streams the selected compatible WebUI release through the ESP32 as a browser download.
  void serveWebApp() {
    WebUiRelease release;
    if (!resolveWebUiRelease(release)) {
      cors();
      _server.send(503, "text/plain; charset=utf-8", "OpenCurtainLab WebUI manifest unavailable or no compatible WebUI release found.");
      return;
    }

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    http.setTimeout(WEB_APP_PROXY_TIMEOUT_MS);

    Serial.printf("[Web] Downloading WebUI %s: %s\n", release.version.c_str(), release.url.c_str());
    if (!http.begin(client, release.url)) {
      Serial.println(F("[Web] WebUI download begin failed."));
      http.end();
      cors();
      _server.send(502, "text/plain; charset=utf-8", "OpenCurtainLab WebUI download failed.");
      return;
    }

    http.addHeader("Accept", "text/html,*/*;q=0.8");
    http.addHeader("User-Agent", "OpenCurtainLab ESP32");
    const int code = http.GET();
    if (code != HTTP_CODE_OK) {
      Serial.printf("[Web] WebUI download GET failed: %d\n", code);
      http.end();
      cors();
      _server.send(502, "text/plain; charset=utf-8", "OpenCurtainLab WebUI download failed.");
      return;
    }

    const int contentLength = http.getSize();
    WiFiClient* remote = http.getStreamPtr();
    WiFiClient browser = _server.client();

    cors();
    _server.sendHeader("Content-Disposition", "attachment; filename=\"" WEB_APP_DOWNLOAD_FILENAME "\"");
    _server.sendHeader("X-OpenCurtainLab-WebUI-Version", release.version);
    _server.sendHeader("X-OpenCurtainLab-WebUI-Match", release.match);
    _server.sendHeader("Cache-Control", "no-store");
    if (contentLength > 0) _server.setContentLength(contentLength);
    else _server.setContentLength(CONTENT_LENGTH_UNKNOWN);
    _server.send(200, "text/html; charset=utf-8", "");

    uint8_t buffer[WEB_APP_STREAM_BUFFER_SIZE];
    int remaining = contentLength;
    unsigned long lastDataMs = millis();
    size_t total = 0;

    while (http.connected() && browser.connected() && (remaining > 0 || remaining == -1)) {
      const size_t available = remote->available();
      if (available) {
        const size_t toRead = min(available, sizeof(buffer));
        const int readLen = remote->readBytes(buffer, toRead);
        if (readLen <= 0) continue;
        browser.write(buffer, readLen);
        total += readLen;
        if (remaining > 0) remaining -= readLen;
        lastDataMs = millis();
        continue;
      }

      if ((millis() - lastDataMs) > WEB_APP_PROXY_TIMEOUT_MS) {
        Serial.println(F("[Web] WebUI stream timed out."));
        break;
      }
      delay(1);
    }

    http.end();

    Serial.printf("[Web] WebUI streamed. version=%s bytes=%u\n", release.version.c_str(), static_cast<unsigned>(total));
    clearDeviceError(DeviceSubsystem::Network);
  }

  // Serves the setup portal in AP mode. In station mode, root streams the manifest-selected WebUI release.
  void serveRootLikePage() {
    if (_wifi.isAccessPointMode()) {
      serveSetupPage();
      return;
    }
    serveWebApp();
  }

  // Registers API, setup portal, captive portal, and CORS routes.
  void setupRoutes() {
    // Root opens the setup page in AP mode or streams the manifest-selected WebUI download in station mode.
    _server.on("/", HTTP_GET, [this]() { serveRootLikePage(); });

    // Common captive-portal probe paths are routed to the same setup/download behavior as root.
    const char* captivePaths[] = { "/generate_204", "/hotspot-detect.html", "/fwlink", "/connecttest.txt", "/ncsi.txt" };
    for (const char* path : captivePaths) {
      // Captive portal probes use the same setup/download behavior as root.
      _server.on(path, HTTP_GET, [this]() { serveRootLikePage(); });
    }

    // Every API route gets an explicit OPTIONS handler for browser-based WebUIs.
    registerOptions("/data");
    registerOptions("/status");
    registerOptions("/version");
    registerOptions("/config");
    registerOptions("/sensors");
    registerOptions("/wifi");
    registerOptions("/wifi/scan");
    registerOptions("/wifi/status");

    // Core API routes are read-only except /config and setup-only /wifi.
    // /status reports device, WiFi, uptime, measurement count, and device-level error.
    _server.on("/status", HTTP_GET, [this]() { sendJson(200, buildStatusJson()); });
    // /version resolves the manifest-selected compatible WebUI version.
    _server.on("/version", HTTP_GET, [this]() { serveVersion(); });
    // GET /config reports firmware capabilities and sanitized runtime settings.
    _server.on("/config", HTTP_GET, [this]() { sendJson(200, JsonBuilder::config(_settings.get())); });
    // /data returns the latest raw measurement for WebUI-side calculation.
    _server.on("/data", HTTP_GET, [this]() { sendJson(200, JsonBuilder::data(_result, _measurementId, _measIdStr, _targetFraction, _mode)); });
    // /sensors returns live non-mutating sensor diagnostics for developer tools.
    _server.on("/sensors", HTTP_GET, [this]() { handleSensorsGet(); });
    // POST /config accepts partial settings updates.
    _server.on("/config", HTTP_POST, [this]() { handleConfigPost(); });
    // POST /wifi tests and stores WiFi credentials only while setup AP mode is active.
    _server.on("/wifi", HTTP_POST, [this]() { handleWifiPost(); });
    // /wifi/scan returns nearby networks for the setup portal.
    _server.on("/wifi/scan", HTTP_GET, [this]() { sendJson(200, _wifi.scanJson()); });
    // /wifi/status returns provisioning state for the setup portal.
    _server.on("/wifi/status", HTTP_GET, [this]() { sendJson(200, buildWifiStatusJson()); });

    // Unknown paths serve the captive portal in AP mode and a JSON error otherwise.
    _server.onNotFound([this]() {
      if (_wifi.isAccessPointMode()) serveSetupPage();
      else sendJson(404, JsonBuilder::error("not found"));
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
    return JsonBuilder::wifiStatus(wifiStatusView(ok));
  }

  // Captures the current WiFi provisioning state in one place to avoid duplicated JSON layouts.
  WifiStatusView wifiStatusView(bool ok = true, const char* error = nullptr) const {
    WifiStatusView view;
    view.ok = ok;
    view.connected = _wifi.isConnected();
    view.apMode = _wifi.isAccessPointMode();
    view.ip = _wifi.staIp();
    view.apIp = _wifi.apIp();
    view.hostname = _wifi.hostname();
    view.mdnsStarted = _wifi.isMdnsStarted();
    view.hasSaved = _wifi.hasStoredCredentials();
    view.savedSsid = _wifi.savedSsid();
    view.currentSsid = _wifi.currentSsid();
    view.hint = _wifi.networkHint();
    view.lastError = _wifi.lastWifiError();
    view.error = error;
    return view;
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
      sendJson(503, JsonBuilder::error("sensors unavailable"));
      return;
    }
    sendJson(200, JsonBuilder::sensors(*_sensorManager));
  }

  // Handles POST /config and returns the sanitized settings.
  void handleConfigPost() {
    if (!_server.hasArg("plain") || !_server.arg("plain").length()) {
      sendJson(400, JsonBuilder::error("missing_body"));
      return;
    }

    const String body = _server.arg("plain");
    StaticJsonDocument<1024> validation;
    DeserializationError err = deserializeJson(validation, body);
    if (err) {
      sendJson(400, JsonBuilder::error("invalid_json"));
      return;
    }

    const bool changed = _settings.applyJson(body);
    if (changed) _settingsChanged = true;

    sendJson(200, JsonBuilder::settingsResponse(_settings.get(), changed));
  }

  // Handles POST /wifi from JSON or form data and tests the credentials.
  void handleWifiPost() {
    if (!_wifi.isAccessPointMode()) {
      sendJson(403, JsonBuilder::error("wifi_setup_locked_in_station_mode"));
      return;
    }

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
      sendJson(400, JsonBuilder::error("ssid missing"));
      return;
    }

    // Credentials are only saved by WifiProvisioning when the connection test succeeds.
    const bool connected = _wifi.connectWithCredentials(ssid, pass, WIFI_CONNECT_TIMEOUT_MS);
    syncNetworkDeviceStatus();
    sendJson(200, JsonBuilder::wifiStatus(wifiStatusView(connected, connected ? nullptr : "connection failed")));
  }

};
