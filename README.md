# ScreenLink

Peer-to-peer screen sharing with audio, like Discord's Go Live without the rest of Discord.
Both people run ScreenLink. There's no server, no account, and no port forwarding. Either
person can share a screen or a single app, and both can share at the same time.

- **Video:** 720p30 up to source resolution at 60 fps, hardware-encoded (H.264 via the GPU)
- **Audio:** app shares send only that app's audio; screen shares send all computer
  audio except ScreenLink itself, so what you're watching never echoes back
- **Privacy:** the stream is end-to-end encrypted (WebRTC DTLS-SRTP) and goes straight between
  the two computers

Requires Windows 10 version 2004 or newer (Windows 11 recommended) on the sharing side.

**Getting it to a friend:** send them `ScreenLink 0.1.0.exe` (portable, no install). It isn't
code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Click
**More info**, then **Run anyway**. Both of you need the same ScreenLink version, because codes
from different versions aren't compatible.

## Connecting

1. **You:** click **Create invite**, then **Copy**, and send the code over any chat.
   Codes are about 600 characters, so they fit in a single Discord message.
2. **Your friend:** pastes it under **Join a session**, clicks **Join**, and sends back the
   answer code that appears.
3. **You:** paste the answer code and click **Connect**.

Paste the answer back promptly, within about 30 seconds. Both computers start trying to reach
each other as soon as the codes exist, and routers stop letting those attempts through after a while.
If it times out, just make a new invite.

> Invite and answer codes contain your IP addresses. Send them only to the person you're
> connecting with.

## Sharing

Click **Share**, pick a screen or an app, choose a quality, and click **Go live**.
While sharing, the toolbar changes quality on the fly. **Text** keeps small text sharp at
the cost of smoothness, which suits code and documents. Click the stats icon to see what's
actually being sent and received.

| Preset | Resolution cap | Bitrate cap |
|---|---|---|
| 720p · 30 fps | 1280×720 | 4 Mb/s |
| 1080p · 30 fps (default) | 1920×1080 | 6 Mb/s |
| 1080p · 60 fps | 1920×1080 | 10 Mb/s |
| Source · 60 fps | native | 15 Mb/s |

The video adapts to the connection. If upload speed runs short, the stats overlay shows
`limited by bandwidth` and resolution drops before frame rate does.

## Troubleshooting

**"Couldn't establish a direct connection."** Some internet connections put you behind a
carrier-grade NAT (common on mobile data and some ISPs), which blocks direct connections. If
it fails every time:
- **Easiest:** install [Tailscale](https://tailscale.com) on both computers and connect as
  usual. ScreenLink picks up the Tailscale network automatically.
- **Alternative:** if you have access to a TURN relay, enter it under **Settings** on both sides.

**60 fps shows about 48 fps on a 144 Hz monitor.** Windows' capture API paces frames against
the display refresh rate, and on 144 Hz displays that lands at 48 fps. On 60, 120 or 240 Hz
displays you get the full 60. Setting the monitor to 120 Hz while streaming works around it.

**An app's audio is silent.** Some apps play sound from a different process than the one
that owns the window. Examples are Microsoft Store apps and games started through a separate
launcher. In the picker, switch **This app only** to **All computer audio**.

**A window shows black.** Protected video (Netflix and other DRM content) can't be captured,
and minimized windows don't produce frames.

## Development

Requires Node 20.19+ (24 LTS recommended). The native audio helper also needs
Visual Studio Build Tools with the **Desktop development with C++** workload.

```bash
npm install
npm approve-scripts electron    # npm 11+ only runs approved install scripts
npm run build:native            # builds bin/audio-capture.exe
npm start
npm run dist                    # portable exe in dist/
```

Without `bin/audio-capture.exe`, ScreenLink falls back to Chromium's system-audio loopback for
screen shares, and app shares have no audio.

### Testing on one machine

Run two instances with separate profiles, and let them trade codes through files:

```bash
electron . --profile=a --auto=host  --exchange-dir=%TEMP%\sl --auto-share=screen --log-stats
electron . --profile=b --auto=guest --exchange-dir=%TEMP%\sl --log-stats
```

| Flag | Purpose |
|---|---|
| `--profile=<name>` | separate settings and storage per instance |
| `--auto=host\|guest`, `--exchange-dir` | exchange codes automatically through files |
| `--auto-share=screen\|<window title>` | start sharing once connected |
| `--auto-preset=<key>` | quality preset for auto-share (`720p30`, `1080p30`, `1080p60`, `source60`) |
| `--auto-script=wait:5,stop,share:screen,preset:720p30,disconnect` | script a session |
| `--auto-open=picker` or `--auto-open=picker-apps` | open the share picker once connected (for screenshots) |
| `--auto-delay-ms=<n>` | host waits before pasting the answer |
| `--auto-mute` | mute playback |
| `--log-stats` | print stream stats as JSON every second |
| `--snap=<file.png>` | save a screenshot of the window every 3 s |
| `--debug-audio` | log Opus packet stereo flags and per-channel tone levels |
| `--devtools` | open DevTools |

Profiles live in `%APPDATA%\ScreenLink-<name>`, so delete them when you're done testing.

`dev/test-pattern/main.js` is a separate Electron app that renders a 60 fps animation and plays
440 Hz on the left and 660 Hz on the right. `dev/pcm-level.js` measures those tones in raw
helper output:

```bash
bin\audio-capture.exe --include-pid <pid> | node dev\pcm-level.js
```

### Connection code format

Codes are `SL2-` + base64url(deflate(JSON `{t, s: sdp}`)), compressed against
`sdp-dictionary.txt`. The dictionary is typical ScreenLink SDP text with IPs, credentials and
fingerprints replaced by placeholders. It shrinks codes from ~1,850 to ~600 characters. To
regenerate it from an `--auto` run's `invite.sdp` and `answer.sdp`:

```bash
node dev/build-sdp-dictionary.js <exchange-dir>
```

A new dictionary makes codes incompatible with older builds, so bump `PREFIX` in
`renderer/signaling.js` with it.
