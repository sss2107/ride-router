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

const savedPlaces = [
  {
    id: "home",
    title: "Home",
    subtitle: "Blk 716, Changi Green",
    query: "Blk 716 Changi Green",
    aliases: ["home", "house", "blk 716", "716", "changi green"],
    icon: "H",
    lat: 1.3469,
    lon: 103.9642,
  },
  {
    id: "changi-airport-t3",
    title: "Changi Airport Terminal 3",
    subtitle: "Airport",
    query: "Changi Airport Terminal 3",
    aliases: ["changi", "airport", "terminal 3", "t3"],
    icon: "A",
    lat: 1.3576,
    lon: 103.9877,
  },
  {
    id: "marina-bay-sands",
    title: "Marina Bay Sands",
    subtitle: "Bayfront",
    query: "Marina Bay Sands",
    aliases: ["mbs", "bayfront"],
    icon: "M",
    lat: 1.2838,
    lon: 103.8591,
  },
  {
    id: "orchard-road",
    title: "Orchard Road",
    subtitle: "Shopping belt",
    query: "Orchard Road",
    aliases: ["orchard"],
    icon: "O",
    lat: 1.3048,
    lon: 103.8318,
  },
  {
    id: "raffles-place",
    title: "Raffles Place",
    subtitle: "CBD",
    query: "Raffles Place",
    aliases: ["raffles", "cbd"],
    icon: "R",
    lat: 1.284,
    lon: 103.8513,
  },
  {
    id: "tanjong-pagar",
    title: "Tanjong Pagar Centre",
    subtitle: "Guoco Tower",
    query: "Tanjong Pagar Centre",
    aliases: ["tanjong pagar", "guoco"],
    icon: "T",
    lat: 1.2764,
    lon: 103.8459,
  },
];

const state = {
  pickup: savedPlaces[0],
  destination: null,
  distanceKm: null,
  quotes: new Map(),
  selectedId: null,
  deferredInstallPrompt: null,
  suggestionAbort: null,
  suggestions: [],
};

const els = {
  pickupInput: document.querySelector("#pickupInput"),
  destinationInput: document.querySelector("#destinationInput"),
  suggestionList: document.querySelector("#suggestionList"),
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

els.pickupInput.value = `${savedPlaces[0].title} · ${savedPlaces[0].subtitle}`;

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

function normalizePlace(place) {
  return {
    label: place.title ?? place.label ?? place.query,
    title: place.title ?? place.label ?? place.query,
    subtitle: place.subtitle ?? "",
    query: place.query ?? place.title ?? place.label,
    lat: place.lat,
    lon: place.lon,
  };
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

function placeMatches(place, query) {
  return suggestionScore(place, query) < Number.POSITIVE_INFINITY;
}

function suggestionScore(place, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 0;
  }
  const title = place.title.toLowerCase();
  const queryText = place.query.toLowerCase();
  const subtitle = place.subtitle.toLowerCase();
  const aliases = place.aliases ?? [];
  if (title === needle || queryText === needle || aliases.some((alias) => alias === needle)) {
    return 0;
  }
  if (title.startsWith(needle)) {
    return 1;
  }
  if (queryText.startsWith(needle)) {
    return 2;
  }
  if (aliases.some((alias) => alias.startsWith(needle))) {
    return 3;
  }
  if (title.includes(needle) || queryText.includes(needle)) {
    return 4;
  }
  if (subtitle.includes(needle)) {
    return 5;
  }
  return Number.POSITIVE_INFINITY;
}

function renderSuggestions(items) {
  state.suggestions = items;
  els.suggestionList.textContent = "";
  els.destinationInput.setAttribute("aria-expanded", items.length > 0 ? "true" : "false");
  els.suggestionList.classList.toggle("visible", items.length > 0);

  for (const item of items) {
    const button = document.createElement("button");
    button.className = "suggestion-option";
    button.type = "button";
    button.role = "option";
    button.innerHTML = `
      <span class="suggestion-icon" aria-hidden="true">${item.icon ?? "P"}</span>
      <span>
        <span class="suggestion-title"></span>
        <span class="suggestion-subtitle"></span>
      </span>
    `;
    button.querySelector(".suggestion-title").textContent = item.title;
    button.querySelector(".suggestion-subtitle").textContent = item.subtitle;
    button.addEventListener("click", () => selectSuggestion(item));
    els.suggestionList.append(button);
  }
}

function selectSuggestion(place) {
  const normalized = normalizePlace(place);
  state.destination = normalized;
  els.destinationInput.value = normalized.query;
  renderSuggestions([]);
  setStatus(`${normalized.title} selected. Compare when ready.`);
}

function localSuggestions(query) {
  return savedPlaces
    .filter((place) => placeMatches(place, query))
    .sort((a, b) => suggestionScore(a, query) - suggestionScore(b, query) || a.title.localeCompare(b.title))
    .slice(0, 4)
    .map((place) => ({ ...place, source: "saved" }));
}

async function remoteSuggestions(query, signal) {
  if (query.trim().length < 3) {
    return [];
  }

  const params = new URLSearchParams({
    q: `${query}, Singapore`,
    format: "jsonv2",
    addressdetails: "1",
    countrycodes: "sg",
    limit: "5",
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    return [];
  }
  const results = await response.json();
  return results.map((result) => {
    const title = result.name || result.display_name.split(",")[0];
    const subtitle = result.display_name
      .split(",")
      .slice(1, 4)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
    return {
      id: `osm-${result.osm_type}-${result.osm_id}`,
      title,
      subtitle,
      query: title,
      icon: "P",
      lat: Number.parseFloat(result.lat),
      lon: Number.parseFloat(result.lon),
      source: "search",
    };
  });
}

function dedupeSuggestions(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique.slice(0, 6);
}

async function updateSuggestions() {
  const query = els.destinationInput.value.trim();
  const local = localSuggestions(query);
  renderSuggestions(local);

  if (state.suggestionAbort) {
    state.suggestionAbort.abort();
  }
  state.suggestionAbort = new AbortController();

  try {
    const remote = await remoteSuggestions(query, state.suggestionAbort.signal);
    renderSuggestions(dedupeSuggestions([...local, ...remote]));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
    renderSuggestions(local);
  }
}

async function geocode(query) {
  const saved = savedPlaces.find((place) => placeMatches(place, query) && query.trim().length >= 3);
  if (saved && saved.title.toLowerCase() === query.trim().toLowerCase()) {
    return normalizePlace(saved);
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
    throw new Error("Destination lookup failed.");
  }
  const [result] = await response.json();
  if (!result) {
    throw new Error("Could not find that destination.");
  }
  return {
    label: result.display_name,
    title: result.display_name.split(",")[0],
    subtitle: result.display_name,
    query,
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
      state.pickup = normalizePlace(savedPlaces[0]);
      els.pickupInput.value = `${savedPlaces[0].title} · ${savedPlaces[0].subtitle}`;
      setStatus("Location blocked, so I am using Home as pickup.");
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
    state.destination = state.destination?.query === destination ? state.destination : await geocode(destination);
    if (!state.pickup) {
      const pickupText = els.pickupInput.value.trim();
      state.pickup = pickupText ? await geocode(pickupText) : normalizePlace(savedPlaces[0]);
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
    if (state.suggestions[0]) {
      selectSuggestion(state.suggestions[0]);
    }
    compareTrip();
  }
});
els.destinationInput.addEventListener("input", () => {
  state.destination = null;
  window.clearTimeout(els.destinationInput.suggestionTimer);
  els.destinationInput.suggestionTimer = window.setTimeout(updateSuggestions, 180);
});
els.destinationInput.addEventListener("focus", updateSuggestions);
document.addEventListener("click", (event) => {
  if (!els.suggestionList.contains(event.target) && event.target !== els.destinationInput) {
    renderSuggestions([]);
  }
});

recomputeSelection(false);
renderProviders();
