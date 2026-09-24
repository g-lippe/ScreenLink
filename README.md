# ScreenLink

Peer-to-peer screen sharing with audio, like Discord's Go Live without the rest of Discord.
Run ScreenLink on a computer, send a friend a short code, and either of you can share a screen
or a single app. Both can share at the same time. Phones can join too, to watch.

- **Video:** 720p30 up to source resolution at 60 fps, hardware-encoded (H.264 via the GPU)
- **Audio:** app shares send only that app's audio; screen shares send all computer
  audio except ScreenLink itself, so what you're watching never echoes back
- **Privacy:** the stream is end-to-end encrypted (WebRTC DTLS-SRTP) and goes straight between
  the two devices. Nothing is hosted, and there's no account.

Requires Windows 10 version 2004 or newer (Windows 11 recommended) on the sharing side.

**Getting it to a friend:** send them `ScreenLink 0.2.0.exe` (portable, no install). It isn't
code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time. Click
**More info**, then **Run anyway**. Both of you need the same ScreenLink version.

## Connecting

1. **You:** click **Create invite** and send the code (like `7K3M-QX9P`) or the link to your
   friend.
2. **Your friend:** enters the code under **Join a session**, or on a phone just opens the link.

That's it. The invite stays open until someone joins, so it doesn't matter who's faster.

How it works without a server: the two apps swap their connection details (a few KB) through
free public message relays (HiveMQ, Mosquitto and EMQX; all three at once, so one being down
doesn't matter). Everything they swap is encrypted with a key derived from the code, so the
relays see neither the code nor your IP addresses. Once connected, the apps leave the relays;
the video and audio never touch them.

**Manual connection.** If the relays are unreachable (a strict firewall, say), click
**Create a manual invite instead** on the start screen. You send a longer code, your friend
pastes it under **Join a session** and sends one back, and you paste that. Manual codes contain
your IP addresses, so send them only to the person you're connecting with.

## Watching on a phone

Phones can watch but not share: mobile browsers don't allow screen capture.

- **From anywhere:** open the invite link (or scan the QR code on the host's invite screen).
  The link opens the web viewer, which joins as a watch-only guest over Wi-Fi or mobile data.
  The viewer works in any modern browser, so friends without the app can watch too.
- **On your own Wi-Fi:** during a session, click the phone button in the toolbar and scan the
  QR code. Your phone then shows whatever your computer is watching, forwarded by the computer
  itself. If Windows asks whether ScreenLink may use the network, allow private networks.

### Publishing the web viewer

The invite link points at `https://g-lippe.github.io/ScreenLink/`, served by GitHub Pages from
this repository. One-time setup on GitHub: **Settings → Pages → Build and deployment → Source:
GitHub Actions**. After that, every push that changes `web/` or `shared/` redeploys it
(`.github/workflows/pages.yml`). Forks change the address in `package.json` under
`screenlink.webViewerUrl`.

## Sharing

Click **Share**, pick a screen or an app, choose a quality, and click **Go live**.
While sharing, the toolbar changes quality on the fly. **Text** keeps small text sharp at
the cost of smoothness, which suits code and documents. Click the stats icon to see what's
actually being sent and received. The small preview of your own share only renders while the
ScreenLink window has focus.

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

**"The host didn't respond."** The invite was cancelled, someone already used it, or the
code has a typo. Invites work once: ask for a new one.

**"Couldn't reach any connection relay."** Your network blocks the public relays. Use a
manual invite.

**60 fps shows about 48 fps on a 144 Hz monitor.** Windows' capture API paces frames against
the display refresh rate, and on 144 Hz displays that lands at 48 fps. On 60, 120 or 240 Hz
displays you get the full 60. Setting the monitor to 120 Hz while streaming works around it.

**An app's audio is silent.** Some apps play sound from a different process than the one
that owns the window. Examples are Microsoft Store apps and games started through a separate
launcher. In the picker, switch **This app only** to **All computer audio**.

**A window shows black.** Protected video (Netflix and other DRM content) can't be captured,
and minimized windows don't produce frames.

**The phone viewer plays without sound.** Browsers block sound until you tap: tap
**Tap to unmute**.

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

Layout: `renderer/` is the desktop UI, `web/` the phone viewer, and `shared/` the code both
use (peer connection, relay client, rendezvous protocol, stats). `node dev/serve-web.js` serves
the viewer at `http://localhost:5174/` the way GitHub Pages does, and
`node dev/relay-test.mjs` checks that each public relay is reachable.

### Testing on one machine

Run two instances with separate profiles, and let them trade the invite through files:

```bash
electron . --profile=a --auto=host  --exchange-dir=%TEMP%\sl --auto-share=screen --log-stats
electron . --profile=b --auto=guest --exchange-dir=%TEMP%\sl --log-stats
```

| Flag | Purpose |
|---|---|
| `--profile=<name>` | separate settings and storage per instance |
| `--auto=host\|guest`, `--exchange-dir` | create/join an invite automatically, trading the code through files |
| `--auto-manual` | with `--auto`: use manual codes instead of the relays |
| `--auto-share=screen\|<window title>` | start sharing once connected |
| `--auto-preset=<key>` | quality preset for auto-share (`720p30`, `1080p30`, `1080p60`, `source60`) |
| `--auto-script=wait:5,stop,share:screen,preset:720p30,disconnect` | script a session (also `focus`, `blur`, `preview-state`) |
| `--auto-open=picker\|picker-apps\|phone` | open the share picker or the phone dialog once connected |
| `--auto-delay-ms=<n>` | manual mode: host waits before pasting the answer |
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

### Protocols

**One-code invites** (`shared/rendezvous.js`): codes are 8 Crockford-base32 characters.
PBKDF2-SHA256 (150,000 rounds) turns a code into an MQTT topic and an AES-GCM key. The guest
repeats `hello` until the host answers with an `offer`; the guest answers with an `answer`,
resent until connected. The host prepares its offer while waiting, and replies `busy` to
anyone else while a guest is connecting.

**Manual codes** (`renderer/signaling.js`): `SL2-` + base64url(deflate(JSON `{t, s: sdp}`)),
compressed against `sdp-dictionary.txt`, typical ScreenLink SDP text with IPs, credentials and
fingerprints replaced by placeholders. To regenerate it from an `--auto --auto-manual` run's
`invite.sdp` and `answer.sdp`:

```bash
node dev/build-sdp-dictionary.js <exchange-dir>
```

A new dictionary makes manual codes incompatible with older builds, so bump `PREFIX` in
`renderer/signaling.js` with it.

**Phone bridge** (`main.js` + `renderer/app.js`): an HTTP server on port 47823 (or any free
port) serves `web/` and `shared/`, plus `POST /bridge/join` and `/bridge/answer`, which require
the random token from the QR link's `#fragment`. Each phone gets its own send-only connection
carrying the tracks the computer receives.
