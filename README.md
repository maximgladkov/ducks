# Duck Hunt — Phase 1 motion-aim prototype

Desktop/TV host + phone light-gun controller over WebRTC (WebSocket fallback).

## Requirements

- Node 20+
- [ngrok](https://ngrok.com/) with an authtoken (`ngrok config add-authtoken …`)

## Install

```bash
npm install
ngrok config add-authtoken YOUR_TOKEN   # once — from https://dashboard.ngrok.com/get-started/your-authtoken
```

## Open on a TV (short link)

```bash
npm start
# or: npm run tv
```

This builds everything into one gateway, opens a single HTTPS tunnel, and prints a **short link** (is.gd) you can type on the TV browser:

```
OPEN ON TV (short link):
https://is.gd/……
```

1. Open that short URL on the TV  
2. Scan the on-screen QR with your phone  
3. Enable motion → calibrate → play  

Same origin serves host (`/`), controller (`/c/`), and signalling (WebSocket).

## Local multi-port dev

```bash
npm run dev:local
```

| Service     | Local                       |
|------------|-----------------------------|
| Gateway/WS | `ws://localhost:8787`       |
| Host       | http://localhost:5173       |
| Controller | http://localhost:5174       |

Then open:

```
http://localhost:5173/?sig=wss://SIGNALLING_DOMAIN&publicController=https://CONTROLLER_DOMAIN
```

ngrok inspector: http://127.0.0.1:4040

## Playtest flow

1. Laptop: open host URL (with `sig` + `publicController` as above).
2. Scan QR with phone → allow motion when prompted (**Enable motion** must be tapped; iOS requires a user gesture).
3. Complete four-corner calibration (host shows targets; pull trigger on each).
4. Shoot moving circles; toggle **Debug** on the host for filters, prediction, aim assist, absolute vs gyro-mouse.
5. Second phone: scan the same QR for another crosshair color.

### Controller buttons

- **Enable motion** — permission + start 60 Hz samples
- **Recentre** — snap aim reference to screen center
- **TRIGGER** — hitscan on the host

### Host debug HUD

Live transport/RTT/clock/sample age, raw/filtered/predicted ghosts, sliders for one-euro + prediction + aim assist + sensitivity, toggles for prediction/filter/assist/absolute aiming, stationary grid mode, recalibrate.

Settings persist in `localStorage` key `duckhunt.debug`.

## Workspace

```
host/         Desktop game + QR + debug HUD
controller/   Phone sensor pipe
signalling/   Session + SDP/ICE + WS relay
shared/       Types, quaternions, homography, one-euro, clock sync (vitest)
```

## Tests

```bash
npm test
```

## Notes

- Samples: unreliable WebRTC data channel `{ ordered: false, maxRetransmits: 0 }`
- Events (trigger/recentre/calib): reliable channel; WS relay if WebRTC fails
- Host is authoritative for hits
- Wake Lock + `touch-action: none` on the controller to avoid sleep / pull-to-refresh
