# Ride Router

Mobile-first cab comparison prototype for Singapore ride apps.

## Run

```sh
node hackathon/ride-router/server.mjs
```

Open the LAN URL printed by the server from your iPhone.

Location access on iPhone Safari requires a secure origin. If the phone blocks GPS on the local `http://` URL, use the manual pickup field or put the server behind an HTTPS tunnel.

## What Works

- Detects current location when the browser permits it.
- Resolves destination text with OpenStreetMap Nominatim.
- Estimates distance and fare bands for Grab, Gojek, CDG Zig, and TADA.
- Lets you confirm real observed fares after opening each app.
- Picks the cheapest confirmed fare, or the cheapest estimate if none are confirmed.
- Copies the destination before opening a ride app so booking is faster.

## Limit

Ride apps do not expose a stable public web API for booking from a third-party page. The final booking step opens the selected app and hands off the destination; in-app confirmation still belongs to the ride app unless you later wire this to an approved partner API or a Shortcuts/accessibility automation.
