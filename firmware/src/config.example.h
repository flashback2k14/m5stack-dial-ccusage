#pragma once
// ---------------------------------------------------------------------------
// config.h -- hier traegst du deine Zugangsdaten ein.
// Tipp: Diese Datei in .gitignore aufnehmen, damit das WLAN-Passwort nicht
// im Repository landet (flashback2k14/ai-dev-workflow ;-)).
// ---------------------------------------------------------------------------

// WLAN
#define WIFI_SSID      "DEIN_WLAN"
#define WIFI_PASSWORD  "DEIN_WLAN_PASSWORT"

// URL des dial-usage-proxy. Im Heimnetz die lokale IP des Docker-Hosts,
// z. B. http://192.168.1.50:8088/usage
// (Cloudflare-Tunnel ginge auch, ist hier aber unnoetig -- das Dial ist
//  ohnehin im selben Netz.)
#define PROXY_URL      "http://192.168.1.50:8088/usage"

// Poll-Intervall in Millisekunden (wie oft die Daten neu geholt werden).
#define POLL_INTERVAL_MS  60000UL

// Buzzer-Feedback beim Drehen des Encoders an/aus.
#define ENABLE_BUZZER  true
