const providers = [
  {
    id: "grab",
    name: "Grab",
    fare: { base: 4.2, perKm: 1.18, surge: 1.08 },
  },
  {
    id: "gojek",
    name: "Gojek",
    fare: { base: 4, perKm: 1.1, surge: 1.03 },
  },
  {
    id: "tada",
    name: "TADA",
    fare: { base: 4.1, perKm: 1.12, surge: 1.02 },
  },
];

const demoCommand = "find the cheapest app from Open Sourced, 10A Perak Rd to changi green condo";

const savedPlaces = [
  {
    id: "open-sourced-cafe",
    title: "Open Sourced",
    query: "Open Sourced, 10A Perak Rd",
    aliases: ["open sourced", "opensourced", "opensoured cafe", "open sourced cafe", "10a perak", "perak rd"],
    lat: 1.3055,
    lon: 103.8533,
  },
  {
    id: "home",
    title: "Changi Green",
    query: "Blk 716 Changi Green",
    aliases: ["home", "blk 716", "716", "changi green", "changi green condo", "upper changi"],
    lat: 1.3469,
    lon: 103.9642,
  },
];

const state = {
  pickup: null,
  destination: null,
  distanceKm: null,
  quotes: new Map(),
  liveScanPollTimer: null,
  estimateOnly: new URLSearchParams(window.location.search).get("estimateOnly") === "1",
};

const els = {
  commandForm: document.querySelector("#commandForm"),
  commandInput: document.querySelector("#commandInput"),
  sendCommandButton: document.querySelector("#sendCommandButton"),
  demoCommandButton: document.querySelector("#demoCommandButton"),
  commandOutput: document.querySelector("#commandOutput"),
  statusLine: document.querySelector("#statusLine"),
};

function setStatus(message, tone = "muted") {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle("error", tone === "error");
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: "SGD",
    maximumFractionDigits: 2,
  }).format(value);
}

function providerLineName(provider) {
  return provider.id === "tada" ? "Tada" : provider.name;
}

function radians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(a, b) {
  const radiusKm = 6371;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const haversine =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(haversine));
}

function estimateFare(provider) {
  const km = state.distanceKm ?? 6;
  const destination = state.destination?.query ?? state.destination?.title ?? "";
  const airportLift = /airport|changi|jewel/i.test(destination) ? 6 : 0;
  const fare = (provider.fare.base + km * provider.fare.perKm + airportLift) * provider.fare.surge;
  return Math.max(5, fare);
}

function providerRows() {
  return providers.map((provider) => {
    const actual = state.quotes.get(provider.id);
    const price = state.estimateOnly ? actual ?? estimateFare(provider) : actual;
    return {
      provider,
      price,
      confirmed: Number.isFinite(actual),
    };
  });
}

function knownPlaceForCommand(text) {
  const normalized = text
    .trim()
    .replace(/[.!?]+$/g, "")
    .toLowerCase();

  if (/open\s*sour|opensour|10a?\s+perak|perak\s+rd/.test(normalized)) {
    return savedPlaces.find((place) => place.id === "open-sourced-cafe");
  }
  if (/changi\s+green|blk\s*716|upper\s+changi/.test(normalized)) {
    return savedPlaces.find((place) => place.id === "home");
  }

  return savedPlaces.find((place) => {
    const aliases = place.aliases ?? [];
    return [place.title, place.query, ...aliases]
      .filter(Boolean)
      .some((value) => normalized.includes(value.toLowerCase()));
  });
}

function normalizePlace(place) {
  return {
    title: place.title ?? place.query,
    query: place.query ?? place.title,
    lat: place.lat,
    lon: place.lon,
  };
}

function cleanRouteText(text) {
  return text.trim().replace(/[.!?]+$/g, "");
}

function rideAppQuery(rawText, place) {
  const raw = cleanRouteText(rawText);
  if (/^(?:home|office)$/i.test(raw)) {
    return place.query;
  }
  return raw || place.query;
}

async function geocode(query) {
  const known = knownPlaceForCommand(query);
  if (known) {
    return normalizePlace(known);
  }

  const params = new URLSearchParams({
    q: `${query}, Singapore`,
    format: "jsonv2",
    limit: "1",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Could not resolve that trip.");
  }
  const [result] = await response.json();
  if (!result) {
    throw new Error("Could not resolve that trip.");
  }
  return {
    title: result.display_name.split(",")[0],
    query,
    lat: Number.parseFloat(result.lat),
    lon: Number.parseFloat(result.lon),
  };
}

function parseFareCommand(command) {
  return command
    .trim()
    .replace(/\s+/g, " ")
    .match(/\b(?:fare|cheapest\s+app)\s+from\s+(.+?)\s+to\s+(.+?)[.!?]*$/i);
}

function renderFareButtons() {
  els.commandOutput.textContent = "";
  els.commandOutput.classList.remove("hidden");

  for (const row of providerRows()) {
    if (!Number.isFinite(row.price)) {
      continue;
    }
    const button = document.createElement("button");
    button.className = `fare-button fare-button--${row.provider.id}`;
    button.type = "button";
    button.textContent = `${providerLineName(row.provider)} fare = ${formatMoney(row.price)}`;
    button.setAttribute("aria-label", `${button.textContent}. Book this cab.`);
    button.addEventListener("click", () => requestBooking(row.provider));
    els.commandOutput.append(button);
  }
}

function renderCheckingState() {
  els.commandOutput.textContent = "";
  els.commandOutput.classList.remove("hidden");

  for (const provider of providers) {
    const button = document.createElement("button");
    button.className = `fare-button fare-button--${provider.id}`;
    button.type = "button";
    button.disabled = true;
    button.textContent = `${providerLineName(provider)} checking...`;
    els.commandOutput.append(button);
  }
}

function applyLiveScanResults(results) {
  for (const result of results ?? []) {
    if (Number.isFinite(result.price)) {
      state.quotes.set(result.id, result.price);
    }
  }
  if (state.quotes.size > 0) {
    renderFareButtons();
  }
}

async function pollLivePhoneScan(jobId) {
  const response = await fetch(`/api/live-quotes/${encodeURIComponent(jobId)}`);
  if (!response.ok) {
    throw new Error("Could not read live fares.");
  }

  const job = await response.json();
  applyLiveScanResults(job.results);
  if (job.status === "running") {
    state.liveScanPollTimer = window.setTimeout(() => {
      pollLivePhoneScan(jobId).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Could not read live fares.", "error");
      });
    }, 900);
    return;
  }
  if (job.status === "failed") {
    throw new Error(job.error ?? "Live fare scan failed.");
  }
  if (state.quotes.size === 0) {
    throw new Error("No live fares detected yet. Keep iPhone Mirroring open and try again.");
  }
  setStatus("");
}

async function runLivePhoneScan() {
  if (state.estimateOnly) {
    setStatus("");
    return;
  }

  window.clearTimeout(state.liveScanPollTimer);
  try {
    const response = await fetch("/api/live-quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destination: state.destination?.query ?? "",
        pickup: state.pickup?.query ?? "",
      }),
    });
    if (response.status !== 202 && !response.ok) {
      throw new Error("Live fare scan failed to start.");
    }
    const job = await response.json();
    await pollLivePhoneScan(job.id);
  } catch (error) {
    els.commandOutput.classList.add("hidden");
    const message =
      error instanceof TypeError
        ? "Could not reach the local ride scanner. Make sure the Ride Router server is running."
        : error instanceof Error
          ? error.message
          : "Could not get live fares.";
    setStatus(message, "error");
  }
}

async function handleFareCommand(command) {
  const match = parseFareCommand(command);
  if (!match) {
    throw new Error("Try: find the cheapest app from xx to yy");
  }

  const pickupText = cleanRouteText(match[1]);
  const destinationText = cleanRouteText(match[2]);
  setStatus("");
  els.commandOutput.classList.add("hidden");
  state.quotes.clear();
  state.pickup = await geocode(pickupText);
  state.destination = await geocode(destinationText);
  state.pickup.query = rideAppQuery(pickupText, state.pickup);
  state.destination.query = rideAppQuery(destinationText, state.destination);
  state.distanceKm = distanceKm(state.pickup, state.destination);
  if (state.estimateOnly) {
    renderFareButtons();
    return;
  }
  renderCheckingState();
  await runLivePhoneScan();
}

function setBusy(isBusy) {
  els.sendCommandButton.disabled = isBusy;
  els.demoCommandButton.disabled = isBusy;
  els.sendCommandButton.textContent = isBusy ? "..." : "Send";
}

async function requestBooking(provider) {
  if (!state.destination || !state.pickup) {
    setStatus("Send a ride request first.", "error");
    return;
  }

  const destination = state.destination.query;
  const confirmed = window.confirm(
    `Book ${provider.name} to ${destination} now? This can request a driver and charge your account.`,
  );
  if (!confirmed) {
    return;
  }

  setStatus(`Booking ${provider.name}...`);
  const buttons = [...els.commandOutput.querySelectorAll("button")];
  for (const button of buttons) {
    button.disabled = true;
  }

  try {
    const response = await fetch("/api/book-provider", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ride-router-booking-confirmed": "yes",
      },
      body: JSON.stringify({
        provider: provider.id,
        destination,
        pickup: state.pickup.query,
        confirmBooking: true,
      }),
    });
    const result = await response.json();
    if (!response.ok || result.status !== "booking-action-tapped") {
      throw new Error(result.error ?? result.status ?? "Booking action was not found.");
    }
    setStatus(`${providerLineName(provider)} booked.`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Booking failed.", "error");
  } finally {
    for (const button of buttons) {
      button.disabled = false;
    }
  }
}

els.commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = els.commandInput.value.trim();
  if (!command) {
    els.commandInput.focus();
    return;
  }

  setBusy(true);
  try {
    await handleFareCommand(command);
  } catch (error) {
    els.commandOutput.classList.add("hidden");
    setStatus(error instanceof Error ? error.message : "Could not understand that.", "error");
  } finally {
    setBusy(false);
  }
});

els.demoCommandButton.addEventListener("click", () => {
  els.commandInput.value = demoCommand;
  els.commandForm.requestSubmit();
});
