/*
 * Manages stored WiFi credentials, station connections, fallback setup access point, captive DNS, and mDNS.
 */

#pragma once
#include <Arduino.h>
#include <WiFi.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include "Config.h"
#include "MeasurementTypes.h"

enum class WifiEvent : uint8_t {
  None,
  Connected,
  ConnectionLost,
  ConnectFailedApStarted,
  AccessPointStarted,
  AccessPointStartFailed,
  MdnsFailed
};

class WifiProvisioning {
public:
  // Loads saved WiFi credentials from Preferences.
  void beginPreferences() {
    _prefs.begin("wifi", false);
    _ssid = _prefs.getString("ssid", "");
    _password = _prefs.getString("password", "");
    _prefs.end();
  }

  // Tries to connect to saved station WiFi or starts setup AP if unavailable.
  bool connectStation(unsigned long timeoutMs) {
    _lastWifiError = "";
    _apStartFailed = false;

    if (_ssid.length() == 0) {
      startAccessPointMode();
      return false;
    }

    Serial.printf("[WiFi] Connecting to '%s' ...\n", _ssid.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(false);
    WiFi.begin(_ssid.c_str(), _password.c_str());

    const bool ok = waitForConnection(timeoutMs);
    if (ok) {
      _connected = true;
      _apMode = false;
      _lostSinceMs = 0;
      _lastWifiError = "";
      _lastEvent = WifiEvent::Connected;
      restartMdns();
      Serial.printf("[WiFi] Connected - IP: %s\n", WiFi.localIP().toString().c_str());
      Serial.printf("[Web] API: http://%s/ or http://%s.local/\n", WiFi.localIP().toString().c_str(), MDNS_NAME);
    } else {
      _lastWifiError = "Connection failed. Setup access point started.";
      Serial.println(F("[WiFi] Not connected - setup access point remains available."));
      startAccessPointMode(WifiEvent::ConnectFailedApStarted);
    }
    return ok;
  }

  // Tests new credentials from the setup portal and stores them on success.
  bool connectWithCredentials(const String& ssid, const String& password, unsigned long timeoutMs) {
    if (!ssid.length()) return false;

    const String testSsid = ssid;
    const String testPassword = password;
    _lastWifiError = "";
    _apStartFailed = false;

    Serial.printf("[WiFi] Setup connect to '%s' ...\n", testSsid.c_str());
    // Keep AP+STA during setup so the browser remains connected while testing credentials.
    WiFi.mode(WIFI_AP_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(false);
    WiFi.disconnect(false, false);
    delay(100);
    WiFi.begin(testSsid.c_str(), testPassword.c_str());

    const bool ok = waitForConnection(timeoutMs);
    if (ok) {
      _ssid = testSsid;
      _password = testPassword;
      saveCredentials(_ssid, _password);
      _connected = true;
      _lostSinceMs = 0;
      _lastWifiError = "";
      _lastEvent = WifiEvent::Connected;
      _closeApAtMs = _apMode ? millis() + 1500UL : 0;

      // When setup happens through the captive portal the ESP32 is still in
      // AP+STA mode. Start mDNS only after the setup AP has been closed and
      // the radio is back in pure STA mode; otherwise some phones/routers do
      // not resolve opencurtainlab.local reliably.
      if (!_apMode) restartMdns();

      Serial.printf("[WiFi] Connected - IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
      _connected = false;
      _lastWifiError = "Connection failed. Check password or use a 2.4 GHz network.";
      _lastEvent = WifiEvent::ConnectFailedApStarted;
      Serial.println(F("[WiFi] Setup connection failed; AP stays active."));
    }
    return ok;
  }

  // Processes captive DNS, AP shutdown, reconnects, mDNS retries, and fallback AP timing.
  void update() {
    const unsigned long now = millis();

    // Retry a failed setup AP start so transient radio failures do not require a power cycle.
    if (_apStartFailed && now - _lastApStartAttemptMs >= WIFI_RECONNECT_INTERVAL_MS) {
      startAccessPointMode(WifiEvent::AccessPointStartFailed);
      return;
    }

    // Captive DNS is only needed while setup AP mode is active.
    if (_apMode) {
      _dns.processNextRequest();
      if (_closeApAtMs && now >= _closeApAtMs) closeAccessPointAfterSetup();
    }
    if (_apMode) return;

    // Mirror the ESP32 WiFi status into explicit state flags and one-shot events.
    const bool nowConnected = WiFi.status() == WL_CONNECTED;
    if (nowConnected && !_connected) {
      _connected = true;
      _lostSinceMs = 0;
      _lastWifiError = "";
      _lastEvent = WifiEvent::Connected;
      restartMdns();
      Serial.printf("[WiFi] Reconnected - IP: %s\n", WiFi.localIP().toString().c_str());
    } else if (!nowConnected && _connected) {
      _connected = false;
      _lostSinceMs = millis();
      _lastEvent = WifiEvent::ConnectionLost;
      stopMdns();
      Serial.println(F("[WiFi] Connection lost."));
    }

    // Retry mDNS after transient startup failures while station WiFi stays connected.
    if (_connected && !_mdnsStarted && now - _lastMdnsAttemptMs >= MDNS_RETRY_INTERVAL_MS) {
      _lastMdnsAttemptMs = now;
      startMdns();
    }

    // Reconnect periodically, then fall back to AP mode after a longer outage.
    if (!_connected && _ssid.length() && now - _lastReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS) {
      _lastReconnectAttempt = now;
      Serial.println(F("[WiFi] Reconnect..."));
      WiFi.disconnect(false);
      WiFi.begin(_ssid.c_str(), _password.c_str());
    }

    if (!_connected && _ssid.length() && _lostSinceMs > 0 &&
        now - _lostSinceMs >= WIFI_FALLBACK_TO_AP_TIMEOUT_MS) {
      _lastWifiError = "Reconnect timeout. Setup access point started.";
      Serial.println(F("[WiFi] Reconnect timeout - switching to setup access point."));
      startAccessPointMode(WifiEvent::ConnectFailedApStarted);
    }
  }

  // Switches the radio into setup access point mode; WiFi scans may temporarily enable station capability.
  void startAccessPointMode(WifiEvent event = WifiEvent::AccessPointStarted) {
    Serial.println(F("[WiFi] Starting access point mode."));

    // Stop any active station connection before starting the setup AP.
    if (_connected || WiFi.status() == WL_CONNECTED) {
      Serial.println(F("[WiFi] Disconnecting station before starting setup AP."));
    }
    stopMdns();
    WiFi.disconnect(false, false);
    delay(100);

    WiFi.mode(WIFI_AP);
    _lastApStartAttemptMs = millis();
    const bool apOk = WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASSWORD);
    delay(100);

    if (!apOk) {
      _apMode = false;
      _connected = false;
      _lostSinceMs = 0;
      _closeApAtMs = 0;
      _apStartFailed = true;
      _lastWifiError = "Setup access point start failed.";
      _lastEvent = WifiEvent::AccessPointStartFailed;
      Serial.println(F("[WiFi] AP start failed."));
      return;
    }

    _dns.start(53, "*", WiFi.softAPIP());
    _closeApAtMs = 0;
    _apMode = true;
    _connected = false;
    _lostSinceMs = 0;
    _apStartFailed = false;
    if (event != WifiEvent::None) _lastEvent = event;
    Serial.printf("[WiFi] AP: %s  IP: %s\n", SETUP_AP_SSID, WiFi.softAPIP().toString().c_str());
  }

  // Persists WiFi credentials to Preferences.
  void saveCredentials(const String& ssid, const String& password) {
    _prefs.begin("wifi", false);
    _prefs.putString("ssid", ssid);
    _prefs.putString("password", password);
    _prefs.end();
  }

  // Returns the configured mDNS host name without .local.
  String hostname() const { return String(MDNS_NAME); }
  // Returns the SSID stored in Preferences.
  String savedSsid() const { return _ssid; }
  // Returns the currently connected SSID.
  String currentSsid() const { return _connected ? WiFi.SSID() : String(""); }
  // Returns whether saved credentials are available.
  bool hasStoredCredentials() const { return _ssid.length() > 0; }
  // Returns the most recent WiFi error text.
  String lastWifiError() const { return _lastWifiError; }
  // Returns whether the mDNS responder is currently running.
  bool isMdnsStarted() const { return _mdnsStarted; }

  // Returns the current blocking network-related device error, if any.
  DeviceStatus deviceStatus() const {
    if (_apStartFailed) return { DeviceError::NetworkAccessPointFailed, DeviceSubsystem::Network };
    return { DeviceError::None, DeviceSubsystem::None };
  }

  // Returns a non-blocking network diagnostic hint for status APIs.
  NetworkHint networkHint() const {
    if (_apMode) {
      if (!_ssid.length()) return NetworkHint::NoCredentials;
      if (_lastWifiError.length()) return NetworkHint::ConnectionFailed;
      return NetworkHint::AccessPointActive;
    }
    if (_connected) {
      if (!_mdnsStarted && _mdnsFailed) return NetworkHint::MdnsFailed;
      return NetworkHint::None;
    }
    if (!_ssid.length()) return NetworkHint::NoCredentials;
    if (_lastWifiError.length()) return NetworkHint::ConnectionFailed;
    if (_lostSinceMs > 0) return NetworkHint::Reconnecting;
    return NetworkHint::None;
  }

  // Deletes saved credentials and starts setup AP mode.
  void resetNetworkAndStartAp() {
    _prefs.begin("wifi", false);
    _prefs.remove("ssid");
    _prefs.remove("password");
    _prefs.end();
    _ssid = "";
    _password = "";
    _lastWifiError = "";
    _apStartFailed = false;
    WiFi.disconnect(false, true);
    _connected = false;
    startAccessPointMode();
  }

  // Scans nearby networks and returns them as JSON.
  String scanJson() {
    // Scanning needs station capability even when the device is currently serving the setup AP.
    if (_apMode) WiFi.mode(WIFI_AP_STA);
    else if (!_connected) WiFi.mode(WIFI_STA);
    const int n = WiFi.scanNetworks(false, true);

    JsonDocument doc;
    doc["ok"] = true;
    JsonArray networks = doc["networks"].to<JsonArray>();

    // Return only the fields the setup page needs.
    for (int i = 0; i < n; i++) {
      JsonObject net = networks.add<JsonObject>();
      net["ssid"] = WiFi.SSID(i);
      net["rssi"] = WiFi.RSSI(i);
      net["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    }

    String out;
    serializeJson(doc, out);
    WiFi.scanDelete();
    return out;
  }

  // Returns whether station WiFi is connected.
  bool isConnected() const { return _connected; }
  // Returns whether setup AP mode is active.
  bool isAccessPointMode() const { return _apMode; }
  // Returns the active station or AP IP address.
  String ip() const { return _connected ? WiFi.localIP().toString() : (_apMode ? WiFi.softAPIP().toString() : String("0.0.0.0")); }
  // Returns the AP IP address when AP mode is active.
  String apIp() const { return _apMode ? WiFi.softAPIP().toString() : String("0.0.0.0"); }
  // Returns the station IP address when connected.
  String staIp() const { return _connected ? WiFi.localIP().toString() : String("0.0.0.0"); }
  // Returns a compact network label for the OLED.
  String networkLine() const { return _connected ? WiFi.SSID() : (_apMode ? String(SETUP_AP_SSID) : String("offline")); }

  // Returns and clears the latest WiFi event.
  WifiEvent consumeEvent() {
    const WifiEvent ev = _lastEvent;
    _lastEvent = WifiEvent::None;
    return ev;
  }

private:
  Preferences _prefs;
  DNSServer _dns;
  String _ssid;
  String _password;
  String _lastWifiError;
  bool _connected = false;
  bool _apMode = false;
  bool _apStartFailed = false;
  bool _mdnsStarted = false;
  bool _mdnsFailed = false;
  unsigned long _lastReconnectAttempt = 0;
  unsigned long _lastApStartAttemptMs = 0;
  unsigned long _lostSinceMs = 0;
  unsigned long _closeApAtMs = 0;
  unsigned long _lastMdnsAttemptMs = 0;
  WifiEvent _lastEvent = WifiEvent::None;

  // Closes the setup AP after successful provisioning and restarts mDNS.
  void closeAccessPointAfterSetup() {
    _closeApAtMs = 0;
    if (!_apMode) return;
    Serial.println(F("[WiFi] Closing setup AP after successful connection."));
    _dns.stop();
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    _apMode = false;
    _connected = WiFi.status() == WL_CONNECTED;
    if (_connected) {
      _lastWifiError = "";
      _lastEvent = WifiEvent::Connected;
      restartMdns();
    }
  }

  // Blocks until station WiFi connects or the timeout expires.
  bool waitForConnection(unsigned long timeoutMs) {
    const unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
      delay(100);
      Serial.print('.');
    }
    Serial.println();
    return WiFi.status() == WL_CONNECTED;
  }

  // Stops mDNS and clears the local started flag after radio or connection changes.
  void stopMdns() {
    if (_mdnsStarted) MDNS.end();
    _mdnsStarted = false;
    _mdnsFailed = false;
  }

  // Starts the mDNS responder and HTTP service advertisement.
  void startMdns() {
    if (_mdnsStarted) return;
    if (WiFi.status() != WL_CONNECTED) return;
    if (WiFi.localIP() == IPAddress(0, 0, 0, 0)) return;

    _lastMdnsAttemptMs = millis();
    if (MDNS.begin(MDNS_NAME)) {
      MDNS.addService("http", "tcp", 80);
      _mdnsStarted = true;
      _mdnsFailed = false;
      Serial.printf("[mDNS] http://%s.local/\n", MDNS_NAME);
    } else {
      _mdnsStarted = false;
      _mdnsFailed = true;
      _lastEvent = WifiEvent::MdnsFailed;
      Serial.println(F("[mDNS] Start failed."));
    }
  }

  // Restarts mDNS after station reconnects or radio mode changes.
  void restartMdns() {
    stopMdns();
    delay(20);
    startMdns();
  }

};
