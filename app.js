const providers = [
  {
    id: "grab",
    name: "Grab",
    initials: "G",
    color: "#31d18d",
    note: "Often strongest availability.",
    scheme: "grab://",
    fallback: "https://www.grab.com/sg/transport/",
    fare: { base: 4.2, perKm: 1.18, surge: 1.08 },
  },
  {
    id: "gojek",
    name: "Gojek",
    initials: "Go",
    color: "#23c16b",
    note: "Usually sharp on short hops.",
    scheme: "gojek://",
    fallback: "https://www.gojek.com/sg/",
    fare: { base: 4, perKm: 1.1, surge: 1.03 },
  },
  {
    id: "cdg",
    name: "CDG Zig",
    initials: "Z",
    color: "#4aa3ff",
    note: "Good when taxis are nearby.",
    scheme: "zig://",
    fallback: "https://www.cdgtaxi.com.sg/",
    fare: { base: 4.8, perKm: 1.04, surge: 1 },
  },
  {
    id: "tada",
    name: "TADA",
    initials: "T",
    color: "#ffd24d",
    note: "Worth checking when demand spikes.",
    scheme: "tada://",
    fallback: "https://tada.global/",
    fare: { base: 4.1, perKm: 1.12, surge: 1.02 },
  },
];

const state = {
  pickup: null,
  destination: null,
  distanceKm: null,
  quotes: new Map(),
  selectedId: null,
  deferredInstallPrompt: null,
};

const els = {
  pickupInput: document.querySelector("#pickupInput"),
  destinationInput: document.querySelector("#destinationInput"),
  locateButton: document.querySelector("#locateButton"),
  routeButton: document.querySelector("#routeButton"),
  statusLine: document.querySelector("#statusLine"),
  distanceMetric: document.querySelector("#distanceMetric"),
  bestMetric: document.querySelector("#bestMetric"),
  savingMetric: document.querySelector("#savingMetric"),
  providerList: document.querySelector("#providerList"),
  providerTemplate: document.querySelector("#providerTemplate"),
  selectedProvider: document.querySelector("#selectedProvider"),
  bookButton: document.querySelector("#bookButton"),
  copyButton: document.querySelector("#copyButton"),
  shareButton: document.querySelector("#shareButton"),
  installButton: document.querySelector("#installButton"),
};

function setStatus(message, tone = "muted") {
  els.statusLine.textContent = message;
  els.statusLine.style.color = tone === "error" ? "var(--danger)" : "var(--muted)";
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: "SGD",
    maximumFractionDigits: 2,
  }).format(value);
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
  const airportLift = /airport|changi|jewel/i.test(els.destinationInput.value) ? 6 : 0;
  const fare = (provider.fare.base + km * provider.fare.perKm + airportLift) * provider.fare.surge;
  return Math.max(5, fare);
}

function providerRows() {
  return providers
    .map((provider) => {
      const estimate = estimateFare(provider);
      const actual = state.quotes.get(provider.id);
      return {
        provider,
        estimate,
        price: Number.isFinite(actual) ? actual : estimate,
        confirmed: Number.isFinite(actual),
      };
    })
    .sort((a, b) => a.price - b.price || a.provider.name.localeCompare(b.provider.name));
}

function recomputeSelection(preferCurrent = true) {
  const rows = providerRows();
  const best = rows[0];
  if (!preferCurrent || !state.selectedId) {
    state.selectedId = best?.provider.id ?? null;
  }

  const selected = rows.find((row) => row.provider.id === state.selectedId) ?? best;
  const high = rows.at(-1);
  els.distanceMetric.textContent = state.distanceKm ? `${state.distanceKm.toFixed(1)} km` : "--";
  els.bestMetric.textContent = selected ? selected.provider.name : "--";
  els.savingMetric.textContent =
    selected && high ? formatMoney(Math.max(0, high.price - selected.price)) : "--";
  els.selectedProvider.textContent = selected
    ? `${selected.provider.name} · ${formatMoney(selected.price)}`
    : "None yet";
  els.bookButton.disabled = !selected;
}

function renderProviders() {
  els.providerList.textContent = "";
  for (const row of providerRows()) {
    const fragment = els.providerTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".provider-card");
    const logo = fragment.querySelector(".provider-logo");
    const title = fragment.querySelector("h2");
    const note = fragment.querySelector("p");
    const estimate = fragment.querySelector(".provider-price strong");
    const quoteInput = fragment.querySelector(".quote-input input");
    const openButton = fragment.querySelector(".open-app");
    const selectButton = fragment.querySelector(".select-app");

    card.dataset.provider = row.provider.id;
    card.style.setProperty("--provider-color", row.provider.color);
    card.classList.toggle("selected", row.provider.id === state.selectedId);
    logo.textContent = row.provider.initials;
    title.textContent = row.provider.name;
    note.textContent = row.confirmed ? "Confirmed fare entered." : row.provider.note;
    estimate.textContent = formatMoney(row.estimate);
    quoteInput.value = state.quotes.get(row.provider.id) ?? "";

    quoteInput.addEventListener("input", () => {
      const value = Number.parseFloat(quoteInput.value.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(value)) {
        state.quotes.set(row.provider.id, value);
      } else {
        state.quotes.delete(row.provider.id);
      }
      recomputeSelection(false);
    });

    quoteInput.addEventListener("change", () => {
      renderProviders();
    });

    openButton.addEventListener("click", () => openProvider(row.provider));
    selectButton.addEventListener("click", () => {
      state.selectedId = row.provider.id;
      recomputeSelection(true);
      renderProviders();
    });

    els.providerList.append(fragment);
  }
}

async function geocode(query) {
  const params = new URLSearchParams({
    q: `${query}, Singapore`,
    format: "jsonv2",
    limit: "1",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Destination lookup failed.");
  }
  const [result] = await response.json();
  if (!result) {
    throw new Error("Could not find that destination.");
  }
  return {
    label: result.display_name,
    lat: Number.parseFloat(result.lat),
    lon: Number.parseFloat(result.lon),
  };
}

function locate() {
  if (!navigator.geolocation) {
    setStatus("This browser does not expose GPS. Enter pickup manually.", "error");
    return;
  }

  setStatus("Finding your current location...");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.pickup = {
        label: "Current location",
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      els.pickupInput.value = "Current location";
      setStatus("Pickup locked from phone GPS.");
    },
    () => {
      setStatus("GPS is blocked here. Use manual pickup or an HTTPS tunnel.", "error");
    },
    { enableHighAccuracy: true, maximumAge: 45_000, timeout: 12_000 },
  );
}

async function compareTrip() {
  const destination = els.destinationInput.value.trim();
  if (!destination) {
    setStatus("Add a destination first.", "error");
    els.destinationInput.focus();
    return;
  }

  setStatus("Resolving destination and estimating fares...");
  try {
    state.destination = await geocode(destination);
    if (!state.pickup) {
      const pickupText = els.pickupInput.value.trim();
      state.pickup = pickupText ? await geocode(pickupText) : { label: "Manual pickup", lat: 1.3521, lon: 103.8198 };
    }
    state.distanceKm = distanceKm(state.pickup, state.destination);
    state.quotes.clear();
    recomputeSelection(false);
    renderProviders();
    setStatus("Estimates ready. Open each app to confirm live fares.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not compare this trip.", "error");
  }
}

async function copyDestination() {
  const destination = els.destinationInput.value.trim();
  if (!destination) {
    setStatus("Nothing to copy yet.", "error");
    return false;
  }
  try {
    await navigator.clipboard.writeText(destination);
    setStatus("Destination copied. Paste it in the ride app.");
    return true;
  } catch {
    setStatus("Clipboard blocked. Select and copy the destination manually.", "error");
    return false;
  }
}

async function openProvider(provider) {
  await copyDestination();
  const destination = encodeURIComponent(els.destinationInput.value.trim());
  const fallback = `${provider.fallback}?q=${destination}`;
  window.location.href = provider.scheme;
  window.setTimeout(() => {
    window.location.href = fallback;
  }, 900);
}

async function bookSelected() {
  const selected = providers.find((provider) => provider.id === state.selectedId);
  if (selected) {
    await openProvider(selected);
  }
}

async function shareTrip() {
  const text = `Ride to ${els.destinationInput.value.trim() || "destination"}: ${els.selectedProvider.textContent}`;
  if (navigator.share) {
    await navigator.share({ title: "Ride Router", text });
    return;
  }
  await navigator.clipboard.writeText(text);
  setStatus("Trip summary copied.");
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  els.installButton.classList.remove("hidden");
});

els.installButton.addEventListener("click", async () => {
  if (!state.deferredInstallPrompt) {
    return;
  }
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  els.installButton.classList.add("hidden");
});

els.locateButton.addEventListener("click", locate);
els.routeButton.addEventListener("click", compareTrip);
els.bookButton.addEventListener("click", bookSelected);
els.copyButton.addEventListener("click", copyDestination);
els.shareButton.addEventListener("click", shareTrip);
els.destinationInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    compareTrip();
  }
});

recomputeSelection(false);
renderProviders();
