/**
 * Claude Usage Dial -- Firmware fuer das M5Stack Dial v1.1
 * ===========================================================================
 * Zeigt die Claude-Code-Nutzung auf dem runden Display an. Mit dem Drehknopf
 * (Encoder) schaltest du durch die einzelnen Usage-Screens; ein Druck auf den
 * Knopf erzwingt ein sofortiges Neuladen der Daten.
 *
 * Datenquelle: der "dial-usage-proxy" im Heimnetz, der `ccusage` ausliest.
 * Siehe README.md fuer das Gesamtsetup.
 *
 * Bedienung:
 *   - Encoder drehen      -> naechster / vorheriger Screen
 *   - Encoder druecken    -> Daten sofort neu laden
 *
 * Display: 240x240 px, rund (GC9A01). Wir zeichnen mittig, damit nichts an
 * den abgeschnittenen Ecken verloren geht.
 */

#include <M5Dial.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "config.h"

// --- Datenmodell -----------------------------------------------------------
// Ein einzelner Screen, wie ihn der Proxy liefert.
struct Screen {
  String label;   // z. B. "5H BLOCK"
  String value;   // grosse Zahl, z. B. "34%"
  String sub;     // Kleingedrucktes darunter
  int    pct;     // 0..100 fuer den Fortschrittsring (0 = kein Ring)
  uint8_t tone;   // 0 = ok, 1 = warn, 2 = crit
};

static const int MAX_SCREENS = 12;
Screen screens[MAX_SCREENS];
int    screenCount   = 0;
int    currentScreen = 0;

// --- Zustand ---------------------------------------------------------------
long          lastEncoderPos = 0;
unsigned long lastPoll       = 0;
bool          dataValid      = false;
String        statusMsg      = "Starte...";

// --- Farben (RGB565) -------------------------------------------------------
#define COL_BG      0x0000  // schwarz
#define COL_TEXT    0xFFFF  // weiss
#define COL_DIM     0x8410  // gedaempftes grau
#define COL_OK      0x2E6B  // gruen
#define COL_WARN    0xFD20  // orange
#define COL_CRIT    0xF986  // rot
#define COL_RING_BG 0x18E3  // dunkler Ringhintergrund
#define COL_ACCENT  0x5D9B  // dezentes blau fuer Akzente

// Mittelpunkt des runden Displays.
static const int CX = 120;
static const int CY = 120;

// ===========================================================================
// Hilfsfunktionen
// ===========================================================================

// Liefert die Tonfarbe fuer einen Screen.
uint16_t toneColor(uint8_t tone) {
  switch (tone) {
    case 2:  return COL_CRIT;
    case 1:  return COL_WARN;
    default: return COL_OK;
  }
}

// Kurzer Buzzer-Klick als haptisches Feedback.
void beep(int freq = 6000, int durMs = 12) {
#if ENABLE_BUZZER
  M5Dial.Speaker.tone(freq, durMs);
#endif
}

// ===========================================================================
// Zeichnen
// ===========================================================================

/**
 * Zeichnet einen Fortschrittsring entlang des Displayrandes.
 * pct: 0..100. Der Ring startet oben (12 Uhr) und laeuft im Uhrzeigersinn.
 */
void drawProgressRing(int pct, uint16_t color) {
  const int radius = 112;
  const int thick  = 10;
  pct = constrain(pct, 0, 100);

  // Hintergrund-Ring (voll).
  for (int a = 0; a < 360; a += 2) {
    float rad = (a - 90) * DEG_TO_RAD;
    int x = CX + cos(rad) * radius;
    int y = CY + sin(rad) * radius;
    M5Dial.Display.fillCircle(x, y, thick / 2, COL_RING_BG);
  }
  // Vordergrund-Ring (Fortschritt).
  int sweep = (pct * 360) / 100;
  for (int a = 0; a < sweep; a += 2) {
    float rad = (a - 90) * DEG_TO_RAD;
    int x = CX + cos(rad) * radius;
    int y = CY + sin(rad) * radius;
    M5Dial.Display.fillCircle(x, y, thick / 2, color);
  }
}

/**
 * Zeichnet kleine Punkte als Seitenindikator (welcher Screen von wie vielen).
 */
void drawScreenDots() {
  if (screenCount <= 1) return;
  const int spacing = 12;
  int totalW = (screenCount - 1) * spacing;
  int startX = CX - totalW / 2;
  int y = CY + 78;
  for (int i = 0; i < screenCount; i++) {
    uint16_t c = (i == currentScreen) ? COL_TEXT : COL_DIM;
    int r = (i == currentScreen) ? 3 : 2;
    M5Dial.Display.fillCircle(startX + i * spacing, y, r, c);
  }
}

/**
 * Rendert den aktuell ausgewaehlten Screen komplett neu.
 */
void renderScreen() {
  M5Dial.Display.fillScreen(COL_BG);

  // Kein Datensatz -> Statusmeldung mittig zeigen.
  if (!dataValid || screenCount == 0) {
    M5Dial.Display.setTextColor(COL_DIM, COL_BG);
    M5Dial.Display.setTextDatum(middle_center);
    M5Dial.Display.setTextFont(&fonts::FreeSansBold12pt7b);
    M5Dial.Display.drawString("CLAUDE", CX, CY - 16);
    M5Dial.Display.setTextColor(COL_TEXT, COL_BG);
    M5Dial.Display.setTextFont(&fonts::FreeSans9pt7b);
    M5Dial.Display.drawString(statusMsg, CX, CY + 14);
    return;
  }

  Screen &s = screens[currentScreen];
  uint16_t accent = toneColor(s.tone);

  // Fortschrittsring (nur wenn pct sinnvoll ist).
  if (s.pct > 0) {
    drawProgressRing(s.pct, accent);
  }

  // Label oben.
  M5Dial.Display.setTextDatum(middle_center);
  M5Dial.Display.setTextColor(accent, COL_BG);
  M5Dial.Display.setTextFont(&fonts::FreeSansBold9pt7b);
  M5Dial.Display.drawString(s.label, CX, CY - 56);

  // Grosse Hauptzahl in der Mitte. Schriftgroesse je nach Stringlaenge.
  M5Dial.Display.setTextColor(COL_TEXT, COL_BG);
  if (s.value.length() <= 5) {
    M5Dial.Display.setTextFont(&fonts::FreeSansBold24pt7b);
    M5Dial.Display.setTextSize(1.4);
  } else {
    M5Dial.Display.setTextFont(&fonts::FreeSansBold24pt7b);
    M5Dial.Display.setTextSize(1.0);
  }
  M5Dial.Display.drawString(s.value, CX, CY - 6);
  M5Dial.Display.setTextSize(1.0);

  // Untertitel.
  M5Dial.Display.setTextColor(COL_DIM, COL_BG);
  M5Dial.Display.setTextFont(&fonts::FreeSans9pt7b);
  M5Dial.Display.drawString(s.sub, CX, CY + 40);

  // Seitenindikator.
  drawScreenDots();

  // Dezenter Hinweis bei ungueltigem/altem Stand.
  if (!dataValid) {
    M5Dial.Display.setTextColor(COL_WARN, COL_BG);
    M5Dial.Display.drawString("offline", CX, CY + 60);
  }
}

// ===========================================================================
// Netzwerk
// ===========================================================================

/**
 * Verbindet mit dem WLAN. Zeigt waehrenddessen einen Status auf dem Display.
 */
void connectWifi() {
  statusMsg = "WLAN...";
  renderScreen();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    statusMsg = "Verbunden";
  } else {
    statusMsg = "WLAN-Fehler";
  }
  renderScreen();
}

/**
 * Holt das Usage-JSON vom Proxy und fuellt das screens[]-Array.
 * Gibt true bei Erfolg zurueck.
 */
bool fetchUsage() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    if (WiFi.status() != WL_CONNECTED) return false;
  }

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  http.begin(PROXY_URL);

  int code = http.GET();
  if (code != 200) {
    statusMsg = "HTTP " + String(code);
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  // JSON parsen. Das Payload ist klein (<2 KB), 4 KB Puffer reicht reichlich.
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    statusMsg = "JSON-Fehler";
    return false;
  }

  JsonArray arr = doc["screens"].as<JsonArray>();
  if (arr.isNull() || arr.size() == 0) {
    statusMsg = "keine Daten";
    return false;
  }

  int n = 0;
  for (JsonObject o : arr) {
    if (n >= MAX_SCREENS) break;
    screens[n].label = o["label"] | "-";
    screens[n].value = o["value"] | "-";
    screens[n].sub   = o["sub"]   | "";
    screens[n].pct   = o["pct"]   | 0;

    const char *tone = o["tone"] | "ok";
    if (strcmp(tone, "crit") == 0)      screens[n].tone = 2;
    else if (strcmp(tone, "warn") == 0) screens[n].tone = 1;
    else                                screens[n].tone = 0;
    n++;
  }
  screenCount = n;
  if (currentScreen >= screenCount) currentScreen = 0;

  return true;
}

/**
 * Laedt die Daten neu und aktualisiert die Anzeige.
 */
void refreshData() {
  statusMsg = "Lade...";
  renderScreen();

  dataValid = fetchUsage();
  lastPoll  = millis();
  renderScreen();
}

// ===========================================================================
// Arduino-Lifecycle
// ===========================================================================

void setup() {
  auto cfg = M5.config();
  M5Dial.begin(cfg, /*encoder=*/true, /*rfid=*/false);

  M5Dial.Display.setRotation(0);
  M5Dial.Display.setBrightness(140);
  M5Dial.Display.fillScreen(COL_BG);

  lastEncoderPos = M5Dial.Encoder.read();

  connectWifi();
  refreshData();
}

void loop() {
  M5Dial.update();

  // --- Encoder-Drehung auswerten ------------------------------------------
  long pos = M5Dial.Encoder.read();
  long diff = pos - lastEncoderPos;

  // Der Encoder liefert mehrere Pulse pro Rastung; 4 Pulse = eine Rastung.
  if (diff >= 4 || diff <= -4) {
    int steps = diff / 4;
    lastEncoderPos += steps * 4;

    if (screenCount > 0) {
      currentScreen = (currentScreen + steps) % screenCount;
      if (currentScreen < 0) currentScreen += screenCount;
      beep();
      renderScreen();
    }
  }

  // --- Encoder-Knopf: sofort neu laden ------------------------------------
  if (M5Dial.BtnA.wasPressed()) {
    beep(8000, 25);
    refreshData();
  }

  // --- Periodisches Polling -----------------------------------------------
  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    bool ok = fetchUsage();
    dataValid = ok;
    lastPoll  = millis();
    renderScreen();
  }

  delay(10);
}
