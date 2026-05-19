# Claude Usage Dial

Zeigt deine Claude-Code-Nutzung auf einem **M5Stack Dial v1.1** an. Mit dem
Drehknopf schaltest du durch die einzelnen Usage-Screens.

```
[ M5Dial ] --HTTP--> [ dial-usage-proxy (Docker, Homeserver) ] --SSH--> [ Mac: ccusage --> ~/.claude/*.jsonl ]
```

## Wie es funktioniert -- und was es *nicht* kann

Anthropic bietet **keine offizielle API**, um die verbleibenden Claude.ai-Pro-
Nachrichten abzufragen. Pro-Limits werden aber über alle Oberflächen geteilt
(claude.ai, Desktop, Claude Code zählen auf denselben Topf). `ccusage` liest die
lokalen JSONL-Logs von Claude Code aus `~/.claude`.

Diese Logs liegen dort, wo du `claude` ausführst -- also auf dem **Mac**, nicht
auf dem Homeserver. Der Proxy läuft zentral auf dem Server und ruft `ccusage`
daher **per SSH remote auf dem Mac** auf.

**Konsequenz:** Das Dial zeigt deinen Verbrauch, *soweit er über Claude Code
läuft*. Reine Chat-Nutzung auf claude.ai taucht in den Logs nicht auf. Die
Prozent-Anzeige ist eine fundierte Annäherung gegen ein konfigurierbares
Token-Budget, kein offizieller Kontostand.

## Projektstruktur

```
dial-usage/
├── proxy/        Node-Service (Docker) -- ruft ccusage per SSH, liefert JSON
└── firmware/     PlatformIO-Projekt fuer das M5Dial
```

## Teil 1 -- Mac vorbereiten

1. **SSH aktivieren:** Systemeinstellungen → Allgemein → Teilen → "Entfernte
   Anmeldung" einschalten.
2. **Node/npx sicherstellen:** `npx --version` muss funktionieren (z. B. über
   Homebrew installiertes Node). Merke dir den Pfad: `which npx` -- bei Apple
   Silicon meist `/opt/homebrew/bin`, bei Intel `/usr/local/bin`.
3. **Claude Code mindestens einmal genutzt haben**, damit Logs existieren.

## Teil 2 -- SSH-Key erzeugen

Der Container meldet sich passwortlos per Key am Mac an (nicht-interaktiv, daher
kein Passwort möglich). Dedizierten Key erzeugen -- **nicht** deinen
persönlichen wiederverwenden:

```bash
cd proxy
mkdir -p keys
ssh-keygen -t ed25519 -f ./keys/id_dial -N "" -C "dial-usage-proxy"
```

Public Key auf dem Mac autorisieren:

```bash
ssh-copy-id -i ./keys/id_dial.pub sebastian@192.168.1.20
# oder manuell: Inhalt von keys/id_dial.pub an ~/.ssh/authorized_keys anhaengen
```

Verbindung testen:

```bash
ssh -i ./keys/id_dial sebastian@192.168.1.20 "echo OK"
```

> Sicherheits-Tipp: Du kannst den Key in `~/.ssh/authorized_keys` auf dem Mac
> auf genau einen Befehl beschränken, z. B. mit einem vorangestellten
> `command="..."`. Für den Heimgebrauch optional.

## Teil 3 -- Proxy aufsetzen

Alle Einstellungen liegen in der `.env`. Vorlage kopieren und anpassen:

```bash
cd proxy
cp .env.example .env
```

In der `.env` anpassen: `SSH_HOST`, `SSH_USER` und `REMOTE_PATH`
(der npx-Pfad von oben).

```bash
docker compose up -d --build
```

Test:

```bash
curl http://localhost:8088/usage      # das Dial-JSON
curl http://localhost:8088/raw        # ungefiltertes ccusage zum Debuggen
```

> Die echte `.env` ist über `.gitignore` vom Repo ausgeschlossen; die
> `.env.example` bleibt als Vorlage drin. Lokal (ohne Docker) lädt `server.js`
> die `.env` über einen eingebauten Fallback selbst -- echte Umgebungs-
> variablen haben dabei immer Vorrang.

### Budgets anpassen

Zwei Richtwerte in der `.env`, die du nach Erfahrung kalibrieren solltest
(Anthropic nennt keine harte Tokenzahl pro Fenster):

| Variable             | Bedeutung                              | Default     |
|----------------------|----------------------------------------|-------------|
| `BLOCK_TOKEN_BUDGET` | Token-Budget pro 5h-Block              | 12.000.000  |
| `WEEK_TOKEN_BUDGET`  | Token-Budget pro Woche                 | 70.000.000  |
| `CACHE_TTL_MS`       | min. Abstand zwischen ccusage-Aufrufen | 60.000 ms   |

**Kalibrierung:** Lass den Proxy ein paar Tage laufen, schau über `/raw` auf
deine `projectedTotal`-Werte kurz bevor du an dein Pro-Limit stößt, und setze
`BLOCK_TOKEN_BUDGET` etwa auf diesen Wert.

## Teil 4 -- Firmware flashen

Voraussetzung: [PlatformIO](https://platformio.org/) (CLI oder VS-Code-Extension).

```bash
cd firmware
cp src/config.example.h src/config.h
```

In `src/config.h` eintragen: WLAN-Daten und die `PROXY_URL`
(IP des Homeservers, z. B. `http://192.168.1.50:8088/usage`).

Dial per USB-C anschließen, dann:

```bash
pio run -t upload      # bauen + flashen
pio device monitor     # serielle Ausgabe ansehen
```

## Bedienung

| Aktion              | Ergebnis                          |
|---------------------|-----------------------------------|
| Drehknopf drehen    | nächster / vorheriger Screen      |
| Drehknopf drücken   | Daten sofort neu laden            |

Die Screens: 5H-Block-Auslastung, Reset-Countdown, Burn-Rate, Block-Kosten,
Wochen-Tokens, Wochen-Kosten, vorheriger Block. Farbring wechselt ab 75 %
auf Orange, ab 90 % auf Rot.

## Anpassungen

- **Screens hinzufügen/ändern:** nur `buildDialPayload()` in `proxy/server.js`.
  Die Firmware rendert generisch, was im `screens`-Array ankommt (bis 12 Stück).
- **Poll-Intervall:** `POLL_INTERVAL_MS` in `config.h`.
- **Buzzer aus:** `ENABLE_BUZZER` in `config.h` auf `false`.
- **3D-Druck:** Für den A1 Mini gibt es auf Printables fertige Ständer für das
  Dial (51 × 51 mm Grundfläche).

## Troubleshooting

| Symptom                  | Ursache / Lösung                                          |
|--------------------------|-----------------------------------------------------------|
| `/usage` gibt HTTP 500   | `/raw` prüfen. SSH-Verbindung? Key autorisiert?           |
| `ccusage failed`         | SSH klappt, aber npx nicht gefunden -> `REMOTE_PATH` prüfen|
| Permission denied (SSH)  | Public Key nicht in `authorized_keys` des Macs            |
| Dial zeigt `WLAN-Fehler` | SSID/Passwort in `config.h`; 2,4-GHz-Netz nötig            |
| `keine Daten` / `IDLE`   | keine aktive Claude-Code-Sitzung in den Logs              |
| Werte wirken zu niedrig  | nur Claude-Code-Nutzung wird erfasst (siehe oben)         |

> Wenn der Mac im Ruhezustand ist, schlägt die SSH-Verbindung fehl und das Dial
> zeigt den letzten Stand als "offline". Sobald der Mac wieder erreichbar ist,
> aktualisiert der nächste Poll automatisch.
