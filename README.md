# Ride Router

A mobile-first ride comparison prototype for Singapore. Ride Router accepts a natural-language trip request, estimates fares across ride-hailing providers, and can assist with local iPhone Mirroring automation for checking live fares.

## What It Does

- Parses commands such as `find the cheapest app from Open Sourced, 10A Perak Rd to Changi Green condo`
- Resolves pickup and destination text with saved places and OpenStreetMap Nominatim
- Estimates fare bands for Grab, Gojek, CDG Zig, and TADA
- Lets users confirm observed fares after opening each ride app
- Chooses the cheapest confirmed fare, or the cheapest estimate when no confirmation is available
- Copies destination text to speed up manual booking
- Includes experimental iPhone Mirroring automation for opening apps, polling OCR results, and preparing booking flows

## Demo

[![Ride Router demo run](assets/demo-poster.jpg)](assets/demo.mp4)

Open the preview above to watch a demo route check.

## Tech Stack

- Node.js HTTP server
- Vanilla HTML, CSS, and JavaScript
- OpenStreetMap Nominatim for geocoding
- macOS `osascript` and screenshot automation
- Apple Vision OCR through local scripts
- Progressive web app manifest

## Repository Structure

```text
.
├── index.html              # Main app UI
├── app.js                  # Browser-side route and fare logic
├── server.mjs              # Static server and local automation endpoints
├── styles.css              # Mobile-first styling
├── manifest.webmanifest    # PWA metadata
├── icon.svg
├── ppt-points.html         # Pitch / presentation notes
└── assets/
    ├── demo.mp4
    └── demo-poster.jpg
```

## Run Locally

```bash
git clone https://github.com/sss2107/ride-router.git
cd ride-router
node server.mjs
```

Open the local or LAN URL printed by the server. For iPhone testing, open the LAN URL from Safari on the phone.

## iPhone Notes

Location access in iPhone Safari requires a secure origin. If GPS is blocked on a local `http://` URL, use the manual pickup field or put the server behind an HTTPS tunnel.

The live booking flow depends on local iPhone Mirroring behavior and known app layouts. It should be treated as a prototype, not a stable production integration.

## Limitations

Ride apps do not expose a stable public booking API for this use case. Final booking still depends on user confirmation and provider app UI state. The automation only attempts final actions when the expected provider booking button is visible.

## Pitch Notes

Open [ppt-points.html](ppt-points.html) for slide-ready notes on the speed strategy, iOS foregrounding limits, OCR challenges, and app-ad friction.
