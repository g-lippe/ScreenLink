# ScreenLink

Serverless P2P screen + audio sharing (Discord Go Live without Discord). Electron 44 +
WebRTC, plain JS ES modules, no bundler/framework. Windows-first. Phones watch through a web
viewer. See README.md for usage and protocols.

## Layout
- `main.js`: window, `app://screenlink/` protocol (`/shared/*` → `shared/`, rest → `renderer/`),
  `desktopCapturer` source list, `setDisplayMediaRequestHandler`, spawns `bin/audio-capture.exe`
  and pipes its PCM to the renderer over a `MessageChannelMain`, manual-code zlib, QR codes
  (`qrcode-generator`, the only runtime dependency), LAN bridge HTTP server, dev CLI flags.
- `preload.js`: `window.screenlink` bridge; forwards the audio MessagePort via `window.postMessage`.
- `renderer/app.js`: desktop UI state machine (connect → session), relay host/join, manual codes,
  sharing, phone bridge peers, self-preview focus gating, stats overlay, dev automation.
- `renderer/signaling.js`: manual `SL2-` codes only (deflate against `sdp-dictionary.txt` in main).
- `renderer/capture.js`: `getDisplayMedia` per preset + helper audio via `pcm-worklet.js`.
- `shared/` (desktop renderer AND web viewer; must stay browser-only, no Electron APIs):
  - `peer.js`: `RTCPeerConnection` wrapper. One video + one audio transceiver, negotiated once;
    sharing is only `replaceTrack`. `receiveOnly` (phone) / `sendOnly` (bridge). Negotiated
    datachannel id 0 carries `hello` / `share-started` / `share-stopped` / `bye`.
  - `sdp.js`: ICE gathering wait, Opus stereo + start-bitrate munging.
  - `mqtt.js`: minimal MQTT 3.1.1-over-WebSocket client. `rendezvous.js`: codes, PBKDF2 →
    topic + AES-GCM key, `RelayChannel` (all brokers at once, dedup), `RoomHost`, `joinRoom`.
  - `stats.js`: getStats condenser.
- `web/`: phone viewer (`#CODE` = relay join over https; `#bridge=TOKEN` = LAN bridge over http).
  Deployed with `shared/` to GitHub Pages by `.github/workflows/pages.yml`.
- `native/audio-capture/main.cpp`: WASAPI process loopback (`--include-hwnd`, `--include-pid`,
  `--exclude-pid`, `--parent-pid`) → float32 48k stereo on stdout. `build.bat` uses vswhere + vcvars64.
- `dev/`: test pattern app (animation + L/R tones), `pcm-level.js` tone meter, `serve-web.js`
  (viewer at :5174, launch config `screenlink-web`), `relay-test.mjs`, `build-sdp-dictionary.js`.

## Hard-won facts (verified on this machine; don't re-derive)
- **Opus stereo needs `stereo=1` in BOTH descriptions.** The encoder reads the remote
  description, but the decoder reads the LOCAL one, and without it stereo packets play back as
  (L+R)/2 mono. `mungeLocalSdp` is applied before `setLocalDescription`, with a fallback to the
  unmunged SDP if the browser rejects it. Verified intact desktop→desktop, desktop→web viewer,
  and desktop→desktop→bridge→viewer (440 Hz only L, 660 Hz only R).
- **One-code joins take ~2.5 s**, mostly PBKDF2 + broker connects. The host's ICE gathering
  always hits the 4 s cap here (a STUN server never answers), so `RoomHost` prepares the offer
  while the invite waits; don't make the host create it on `hello`. All three brokers
  (HiveMQ 8884, Mosquitto 8081, EMQX 8084, all wss) worked on 2026-09-24. The host leaves the
  relays once connected, so a stale code times out after 20 s instead of getting `busy`.
- **Manual codes must fit a 2000-char Discord message.** Codec pruning (host offers only its
  preferred codec with H.264 limited to packetization-mode=1, plus VP8, RTX, Opus; the answer
  follows the offer), stripping TCP candidates, and the SDP dictionary keep them at ~600.
- **60 fps presets deliver ~48 fps on the 144 Hz monitor.** Chromium polls at ~58 Hz, but WGC
  only has new frames ~48×/s (≈144/3). Not the 50%-CPU capture throttle (captures take 1–2 ms),
  not timer resolution, and not the constraint: requesting 90 or 120 fps and enabling
  `WebRtcAllowWgcUsingTexture` changed nothing, and `ZeroCopyDesktopCapture` breaks capture.
  30 fps presets hit 29–30.
- H.264 encodes on the RTX 4070 (`MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`).
- The bridge forwards the *received* tracks into a second PeerConnection. Chromium re-encodes
  them; remote audio forwarding works (stereo intact).
- The web viewer over the LAN bridge is an insecure context (http): no `crypto.subtle`,
  `crypto.randomUUID`, or wake lock there. Keep `shared/` code usable without them on the
  bridge path (only `rendezvous.js` needs subtle, and only the relay path imports it at runtime).
- Chromium's `audio: 'loopback'` fails here with `NotReadableError: Could not start audio source`.
  `capture.js` retries video-only. The native helper is the real audio path.
- Helper PCM vs AudioContext clocks drift ~4 ms/min (5-min run, 0 underruns). `pcm-worklet.js`
  skips one frame per quantum above 100 ms of buffer and hard-resets above 200 ms.
- The portable exe (`npm run dist`) is verified end to end: the helper runs from
  `resources/bin`, the bridge serves `web/` + `shared/` from inside the asar, and received stereo
  is intact. It's unsigned, so SmartScreen warns.
- The received stream plays inside ScreenLink's own process tree, so the screen-share mode
  (`--exclude-pid <main pid>`) never echoes it back.
- Electron 44's installer needs Node ≥ 20.19. npm 11 needs `npm approve-scripts electron`
  (recorded in package.json `allowScripts`).
- The desktop app can't be driven from the Browser pane, but the web viewer can: run the
  `screenlink-web` launch config (or open the bridge URL) against an `--auto=host` instance.
  Verify the desktop side with two `--profile` instances plus `--auto=host|guest --exchange-dir`,
  `--log-stats`, `--snap`, and `--auto-script` (see README). `taskkill //IM electron.exe //F`
  between runs. Test profiles land in `%APPDATA%\ScreenLink-<name>`; `ScreenLink` (no suffix)
  is Gabriel's real profile.
- Keep files LF. Patching with Python text mode on Windows wrote CRLF and once broke a `'\r\n'`
  literal; bash one-liners mangle backticks, so write patch scripts to a file.
