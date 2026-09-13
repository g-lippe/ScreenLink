# ScreenLink

Serverless P2P screen + audio sharing (Discord Go Live without Discord). Electron 44 +
WebRTC, plain JS ES modules, no bundler/framework. Windows-first. See README.md for usage.

## Layout
- `main.js`: window, `app://screenlink/` protocol (serves `renderer/`), `desktopCapturer`
  source list, `setDisplayMediaRequestHandler`, spawns `bin/audio-capture.exe` and pipes its
  PCM to the renderer over a `MessageChannelMain`, dev CLI flags.
- `preload.js`: `window.screenlink` bridge; forwards the audio MessagePort via `window.postMessage`.
- `renderer/app.js`: UI state machine (connect → session), sharing, stats overlay, dev automation.
- `renderer/peer.js`: `RTCPeerConnection` wrapper: one video + one audio transceiver, both
  `sendrecv`, negotiated once; sharing is only `replaceTrack`. Negotiated datachannel id 0 carries
  `share-started` / `share-stopped` / `bye`.
- `renderer/signaling.js`: non-trickle SDP → deflate-raw → base64url codes (`SL1-` prefix), SDP munging.
- `renderer/capture.js`: `getDisplayMedia` per preset + helper audio via `pcm-worklet.js`.
- `native/audio-capture/main.cpp`: WASAPI process loopback (`--include-hwnd`, `--include-pid`,
  `--exclude-pid`, `--parent-pid`) → float32 48k stereo on stdout. `build.bat` uses vswhere + vcvars64.
- `dev/`: test pattern app (animation + L/R tones) and `pcm-level.js` tone meter.

## Hard-won facts (verified on this machine; don't re-derive)
- **Opus stereo needs `stereo=1` in BOTH descriptions.** The encoder reads the remote
  description, but the decoder reads the LOCAL one, and without it stereo packets play back as
  (L+R)/2 mono. `mungeLocalSdp` is applied before `setLocalDescription`, with a fallback to the
  unmunged SDP if Chromium rejects it. Verify with `--debug-audio` plus `dev/pcm-level.js`.
- **Codes must fit a 2000-char Discord message.** Three things keep them at ~600:
  - The host offers only its preferred video codec (H.264 limited to packetization-mode=1),
    VP8 as fallback, RTX, and Opus. The guest applies no preferences and follows the offer.
  - TCP candidates are stripped.
  - The main process deflates against `sdp-dictionary.txt` (rebuild with
    `dev/build-sdp-dictionary.js`). Changing the dictionary changes the format, so bump
    `PREFIX` too.
  Without all this, codes were 2.6k characters.
- **60 fps presets deliver ~48 fps on the 144 Hz monitor.** Chromium polls at ~58 Hz, but WGC
  only has new frames ~48×/s (≈144/3). Not the 50%-CPU capture throttle (captures take 1–2 ms),
  not timer resolution, and not the constraint: requesting 90 or 120 fps and enabling
  `WebRtcAllowWgcUsingTexture` changed nothing, and `ZeroCopyDesktopCapture` breaks capture.
  30 fps presets hit 29–30.
- H.264 encodes on the RTX 4070 (`MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)`).
- Chromium's `audio: 'loopback'` fails here with `NotReadableError: Could not start audio source`.
  `capture.js` retries video-only. The native helper is the real audio path.
- Helper PCM vs AudioContext clocks drift ~4 ms/min (5-min run, 0 underruns). `pcm-worklet.js`
  skips one frame per quantum above 100 ms of buffer and hard-resets above 200 ms.
- The portable exe (`npm run dist`) is verified end to end: the helper runs from
  `resources/bin`, and received stereo is intact. It's unsigned, so SmartScreen warns.
- The received stream plays inside ScreenLink's own process tree, so the screen-share mode
  (`--exclude-pid <main pid>`) never echoes it back.
- Electron 44's installer needs Node ≥ 20.19. npm 11 needs `npm approve-scripts electron`
  (recorded in package.json `allowScripts`).
- An Electron app can't be driven from the Browser pane. Verify with two `--profile` instances plus
  `--auto=host|guest --exchange-dir`, `--log-stats`, `--snap`, and `--auto-script` (see README).
  `taskkill //IM electron.exe //F` between runs. Test profiles land in `%APPDATA%\ScreenLink-<name>`.
- Keep files LF. Patching with Python text mode on Windows wrote CRLF and once broke a `'\r\n'` literal.
