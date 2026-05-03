import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "4188", 10);
const execFileAsync = promisify(execFile);
const liveQuoteJobs = new Map();
let nextLiveQuoteJobId = 1;
const rideSelectionAction = /\bChoose this ride\b/i;
const finalBookingAction = /\b(?:Book(?:\s+[A-Za-z]+)?|Find driver|Confirm booking)\b/i;
const tadaDestinationSuggestionTapYBias = 0.02;
const rideProviders = [
  { id: "gojek", name: "Gojek", searchName: "Gojek", waitMs: 1300, prepare: prepareGojekDemo },
  { id: "grab", name: "Grab", searchName: "Grab", waitMs: 1400, prepare: prepareGrabDemo },
  { id: "tada", name: "TADA", searchName: "TADA", waitMs: 1200, prepare: prepareTadaDemo },
];

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function localAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function osascript(args) {
  return run("osascript", args);
}

async function activatePhone() {
  await osascript(["-e", 'tell application "iPhone Mirroring" to activate']);
  await sleep(250);
}

async function phoneWindow() {
  await activatePhone();
  const raw = await osascript([
    "-e",
    'tell application "System Events" to tell process "iPhone Mirroring" to get {position, size} of front window',
  ]);
  const values = raw
    .split(",")
    .map((value) => Number.parseFloat(value.trim()))
    .filter(Number.isFinite);
  if (values.length < 4) {
    throw new Error("Could not read iPhone Mirroring window bounds.");
  }
  return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

async function clickPoint(x, y) {
  const script = [
    'ObjC.import("CoreGraphics");',
    `const p=$.CGPointMake(${Math.round(x)},${Math.round(y)});`,
    "const d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,p,$.kCGMouseButtonLeft);",
    "const u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,p,$.kCGMouseButtonLeft);",
    "$.CGEventPost($.kCGHIDEventTap,d);",
    "delay(0.08);",
    "$.CGEventPost($.kCGHIDEventTap,u);",
  ].join(" ");
  await osascript(["-l", "JavaScript", "-e", script]);
}

async function tapRelative(win, x, y) {
  await clickPoint(win.x + win.width * x, win.y + win.height * y);
}

async function keyCode(code, modifiers = "") {
  const suffix = modifiers ? ` using ${modifiers}` : "";
  await osascript(["-e", `tell application "System Events" to key code ${code}${suffix}`]);
}

async function pasteText(text) {
  await osascript([
    "-e",
    `set the clipboard to ${JSON.stringify(text)}`,
    "-e",
    'tell application "System Events" to keystroke "a" using command down',
    "-e",
    'tell application "System Events" to keystroke "v" using command down',
  ]);
}

async function goHome() {
  await activatePhone();
  await keyCode(53).catch(() => {});
  await sleep(80);
  await keyCode(18, "command down");
  await sleep(380);
}

async function openTravelFolder(win) {
  await tapRelative(win, 0.61, 0.395);
  await sleep(260);
}

async function dragRelative(win, fromX, fromY, toX, toY) {
  const startX = Math.round(win.x + win.width * fromX);
  const startY = Math.round(win.y + win.height * fromY);
  const endX = Math.round(win.x + win.width * toX);
  const endY = Math.round(win.y + win.height * toY);
  const script = [
    'ObjC.import("CoreGraphics");',
    `const s=$.CGPointMake(${startX},${startY});`,
    `const e=$.CGPointMake(${endX},${endY});`,
    "const d=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDown,s,$.kCGMouseButtonLeft);",
    "const m=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseDragged,e,$.kCGMouseButtonLeft);",
    "const u=$.CGEventCreateMouseEvent(null,$.kCGEventLeftMouseUp,e,$.kCGMouseButtonLeft);",
    "$.CGEventPost($.kCGHIDEventTap,d);",
    "delay(0.12);",
    "$.CGEventPost($.kCGHIDEventTap,m);",
    "delay(0.12);",
    "$.CGEventPost($.kCGHIDEventTap,u);",
  ].join(" ");
  await osascript(["-l", "JavaScript", "-e", script]);
}

async function killForegroundPhoneApp(win) {
  await activatePhone();
  await keyCode(19, "command down");
  await sleep(500);
  await dragRelative(win, 0.5, 0.58, 0.5, 0.14);
  await sleep(450);
  await goHome();
}

async function openPhoneApp(win, provider, runDir) {
  const appPositions = {
    Gojek: { x: 0.29, y: 0.405 },
    TADA: { x: 0.71, y: 0.405 },
    Grab: { x: 0.29, y: 0.515 },
  };
  const position = appPositions[provider.searchName];
  if (!position) {
    throw new Error(`Unknown phone app position: ${provider.searchName}`);
  }

  await goHome();
  await openTravelFolder(win);
  await tapRelative(win, position.x, position.y);
  await sleep(provider.waitMs);
  if (runDir) {
    const check = await ocrPhone(win, runDir, `${provider.id}-app-open-check`);
    if (/\bTravel\b/i.test(check.ocr) && new RegExp(`\\b${provider.searchName}\\b`, "i").test(check.ocr)) {
      await keyCode(53).catch(() => {});
      await sleep(400);
      await openTravelFolder(win);
      await tapRelative(win, position.x, position.y);
      await sleep(provider.waitMs);
    }
  }
}

async function capturePhoneImage(win, runDir, providerId) {
  const cropPath = join(runDir, `${providerId}-phone.png`);
  await run("screencapture", [
    "-x",
    `-R${Math.round(win.x)},${Math.round(win.y)},${Math.round(win.width)},${Math.round(win.height)}`,
    cropPath,
  ]);
  return cropPath;
}

async function ocrImage(imagePath) {
  const script = `
    ObjC.import('Foundation');
    ObjC.import('Vision');
    const url = $.NSURL.fileURLWithPath(${JSON.stringify(imagePath)});
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 1;
    req.usesLanguageCorrection = false;
    handler.performRequestsError($([req]), null);
    const results = [];
    const observations = req.results;
    const count = observations ? observations.count : 0;
    for (let i = 0; i < count; i++) {
      const obs = observations.objectAtIndex(i);
      const candidates = obs.topCandidates(1);
      if (candidates.count > 0) {
        results.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
      }
    }
    console.log(results.join('\\n'));
  `;
  const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function ocrImageItems(imagePath) {
  const script = `
    ObjC.import('Foundation');
    ObjC.import('Vision');
    const url = $.NSURL.fileURLWithPath(${JSON.stringify(imagePath)});
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
    const req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 1;
    req.usesLanguageCorrection = false;
    handler.performRequestsError($([req]), null);
    const results = [];
    const observations = req.results;
    const count = observations ? observations.count : 0;
    for (let i = 0; i < count; i++) {
      const obs = observations.objectAtIndex(i);
      const candidates = obs.topCandidates(1);
      if (candidates.count > 0) {
        const box = obs.boundingBox;
        results.push({
          text: ObjC.unwrap(candidates.objectAtIndex(0).string),
          x: box.origin.x,
          y: box.origin.y,
          width: box.size.width,
          height: box.size.height,
        });
      }
    }
    console.log(JSON.stringify(results));
  `;
  const { stdout, stderr } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim() || stderr.trim() || "[]");
}

async function ocrPhone(win, runDir, name) {
  const imagePath = await capturePhoneImage(win, runDir, name);
  return { imagePath, ocr: await ocrImage(imagePath) };
}

async function ocrPhoneItems(win, runDir, name) {
  const imagePath = await capturePhoneImage(win, runDir, name);
  const items = await ocrImageItems(imagePath);
  return {
    imagePath,
    items,
    ocr: items.map((item) => item.text).join("\n"),
  };
}

function itemCenter(item) {
  return {
    x: item.x + item.width / 2,
    y: 1 - (item.y + item.height / 2),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function findTextItem(items, pattern, { minY = 0, maxY = 1, prefer = "top" } = {}) {
  const matches = items
    .map((item) => ({ item, center: itemCenter(item) }))
    .filter(({ item, center }) => pattern.test(item.text) && center.y >= minY && center.y <= maxY);
  matches.sort((a, b) => (prefer === "bottom" ? b.center.y - a.center.y : a.center.y - b.center.y));
  return matches[0] ?? null;
}

async function tapText(win, runDir, name, pattern, options) {
  const screen = await ocrPhoneItems(win, runDir, name);
  const match = findTextItem(screen.items, pattern, options);
  if (!match) {
    throw new Error(`Could not find ${pattern} on ${name}.`);
  }
  await tapRelative(win, match.center.x, match.center.y);
  return match.item.text;
}

async function tapTextOrFallback(win, runDir, name, pattern, options, fallback) {
  try {
    return await tapText(win, runDir, name, pattern, options);
  } catch (error) {
    if (!fallback) {
      throw error;
    }
    await tapRelative(win, fallback.x, fallback.y);
    return "fallback";
  }
}

async function tapInputField(win, runDir, name, pattern, options, fallback) {
  const screen = await ocrPhoneItems(win, runDir, name);
  const match = findTextItem(screen.items, pattern, options);
  const point = match
    ? {
        x: clamp(match.center.x + 0.18, 0.38, 0.52),
        y: clamp(match.center.y - 0.008, options?.minY ?? 0, options?.maxY ?? 1),
      }
    : fallback;
  if (!point) {
    throw new Error(`Could not find ${pattern} on ${name}.`);
  }
  await tapRelative(win, point.x, point.y);
  return match?.item.text ?? "fallback";
}

async function safeTapRelative(win, runDir, name, x, y) {
  if (y > 0.82) {
    const before = await ocrPhone(win, runDir, `${name}-safety`);
    if (finalBookingAction.test(before.ocr)) {
      throw new Error(`Stopped before tapping a final booking action on ${name}.`);
    }
  }
  await tapRelative(win, x, y);
}

function destinationText(requestBody) {
  return String(requestBody.destination ?? "Changi Green").trim() || "Changi Green";
}

function destinationPattern(requestBody) {
  const destination = destinationText(requestBody).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/changi\s+green\s+condo/i.test(destination)) {
    return /Changi\s*green\s*condo/i;
  }
  if (/changi\s+green|716\s+upper\s+changi/i.test(destination)) {
    return /Changi\s*Green|716\s+Upper\s+Changi|Upper\s+Changi\s+Road\s+East/i;
  }
  return new RegExp(destination, "i");
}

function tadaDestinationSearchText(requestBody) {
  const destination = destinationText(requestBody);
  if (/changi\s+green\s+condo/i.test(destination)) {
    return "Changi green condo 718A Upper Changi Rd E";
  }
  return destination;
}

function hasWhereToInput(ocr) {
  return /Where\s*to\??/i.test(ocr);
}

function isTadaBlockingPromo(ocr) {
  return /Battle of the ages|Opt in to|Gadget Prize|Mission|Prize Pool/i.test(ocr) && !hasWhereToInput(ocr);
}

function isTadaFareScreen(ocr) {
  return /(\bBook\b|Drop off|SGD|\d+\.\d{2}\s*SGD)/i.test(ocr);
}

function isGrabTransportLanding(ocr) {
  return (
    hasWhereToInput(ocr) &&
    /Rides for your every need|Advance Booking|Premium|No missed flights/i.test(ocr)
  );
}

function gojekDestinationPattern(requestBody) {
  const destination = destinationText(requestBody);
  if (/changi\s+green\s+condo|changi\s+green|716\s+upper\s+changi/i.test(destination)) {
    return /Changi\s*Green|(?:Bl(?:oc)?k|Blk)\s*716|Upper\s+Changi/i;
  }
  return destinationPattern(requestBody);
}

function isGojekFareScreen(ocr) {
  return /\b(?:GoCar|Find driver|Cash\s*S\$|S\$)\b/i.test(ocr);
}

async function tapGojekDestinationSuggestion(win, runDir, requestBody) {
  const destination = destinationText(requestBody);
  const pattern = gojekDestinationPattern(requestBody);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const screen = await ocrPhoneItems(
      win,
      runDir,
      attempt === 0 ? "gojek-destination-suggestion" : "gojek-destination-suggestion-retry",
    );
    if (/confirm pickup point|select a pickup point|pickup point/i.test(screen.ocr) || isGojekFareScreen(screen.ocr)) {
      return "route-progressed";
    }
    const match = findTextItem(screen.items, pattern, { minY: 0.25, prefer: "top" });
    if (match) {
      await tapRelative(win, match.center.x, match.center.y);
      return match.item.text;
    }
    if (!/Where\s+do\s+you\s+want\s+to\s+go|Your current location|Add a destination|Select via map/i.test(screen.ocr)) {
      break;
    }
    await sleep(1200);
  }
  throw new Error(`Gojek destination suggestion did not include "${destination}".`);
}

async function tapTadaDestinationSuggestion(win, runDir, requestBody) {
  const destination = tadaDestinationSearchText(requestBody);
  const pattern = destinationPattern(requestBody);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const screen = await ocrPhoneItems(
      win,
      runDir,
      attempt === 0 ? "tada-destination-suggestion" : "tada-destination-suggestion-retry",
    );
    const match = findTextItem(screen.items, pattern, { minY: 0.32, prefer: "top" });
    if (match) {
      await tapRelative(
        win,
        match.center.x,
        clamp(match.center.y + tadaDestinationSuggestionTapYBias, 0, 0.96),
      );
      return match.item.text;
    }
    if (!hasWhereToInput(screen.ocr)) {
      break;
    }
    await tapInputField(
      win,
      runDir,
      "tada-where-to-retry",
      /Where\s*to\??/i,
      { minY: 0.16, maxY: 0.32, prefer: "top" },
      { x: 0.43, y: 0.22 },
    );
    await sleep(400);
    await pasteText(tadaDestinationSearchText(requestBody));
    await sleep(1400);
  }
  throw new Error(
    `TADA destination suggestion did not include "${destination}"; stopped before tapping a saved place.`,
  );
}

async function leaveTadaFareScreen(win, runDir, requestBody) {
  const requestedDestination = destinationPattern(requestBody);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tapRelative(win, 0.09, 0.14);
    await sleep(900);
    const screen = await ocrPhone(win, runDir, `tada-after-stale-fare-back-${attempt + 1}`);
    if (!isTadaFareScreen(screen.ocr) || requestedDestination.test(screen.ocr)) {
      return screen;
    }
  }
  throw new Error(
    `TADA is already showing a fare for a different destination than "${destinationText(requestBody)}".`,
  );
}

async function prepareGojekDemo(win, runDir, requestBody) {
  const initial = await ocrPhone(win, runDir, "gojek-pre-route");
  if (!/Search\s+for\s+a\s+destination/i.test(initial.ocr)) {
    if (isGojekFareScreen(initial.ocr) && gojekDestinationPattern(requestBody).test(initial.ocr)) {
      return;
    }
    throw new Error("Gojek destination search was not visible.");
  }

  await tapInputField(
    win,
    runDir,
    "gojek-search-destination",
    /Search\s+for\s+a\s+destination/i,
    { minY: 0.38, maxY: 0.58, prefer: "top" },
    { x: 0.46, y: 0.48 },
  );
  await sleep(500);
  await pasteText(destinationText(requestBody));
  await sleep(1300);
  await tapGojekDestinationSuggestion(win, runDir, requestBody);
  await sleep(1800);
  const check = await ocrPhone(win, runDir, "gojek-pre-confirm");
  if (/confirm pickup point/i.test(check.ocr)) {
    await safeTapRelative(win, runDir, "gojek-confirm-pickup", 0.5, 0.935);
    await sleep(2600);
    return;
  }
  if (!isGojekFareScreen(check.ocr)) {
    throw new Error("Gojek did not reach fare selection after choosing the destination.");
  }
}

async function prepareTadaDemo(win, runDir, requestBody) {
  let initial = await ocrPhone(win, runDir, "tada-pre-route");
  const requestedDestination = destinationPattern(requestBody);
  if (isTadaBlockingPromo(initial.ocr)) {
    try {
      await tapTextOrFallback(
        win,
        runDir,
        "tada-close-promo",
        /^×$|^x$/i,
        { minY: 0.08, maxY: 0.18, prefer: "top" },
        /\bHome\b/i.test(initial.ocr) ? null : { x: 0.08, y: 0.13 },
      );
      await sleep(1000);
      initial = await ocrPhone(win, runDir, "tada-after-promo-close");
    } catch (error) {
      if (!/\bHome\b/i.test(initial.ocr)) {
        throw error;
      }
    }
  }
  if (!hasWhereToInput(initial.ocr) && /\bHome\b/i.test(initial.ocr)) {
    await tapTextOrFallback(
      win,
      runDir,
      "tada-home-tab",
      /\bHome\b/i,
      { minY: 0.88, prefer: "bottom" },
      { x: 0.12, y: 0.95 },
    );
    await sleep(900);
    initial = await ocrPhone(win, runDir, "tada-after-home-tab");
  }

  if (isTadaFareScreen(initial.ocr)) {
    if (!requestedDestination.test(initial.ocr)) {
      initial = await leaveTadaFareScreen(win, runDir, requestBody);
    } else {
      return;
    }
  }

  if (hasWhereToInput(initial.ocr)) {
    await tapInputField(
      win,
      runDir,
      "tada-where-to",
      /Where\s*to\??/i,
      { minY: 0.22, maxY: 0.34, prefer: "top" },
      { x: 0.43, y: 0.29 },
    );
    await sleep(500);
    await pasteText(tadaDestinationSearchText(requestBody));
    await sleep(1200);
  }
  await tapTadaDestinationSuggestion(win, runDir, requestBody);
  await sleep(1800);
  const confirm = await ocrPhone(win, runDir, "tada-pre-confirm");
  if (/confirm|set pickup location/i.test(confirm.ocr)) {
    await safeTapRelative(win, runDir, "tada-confirm-pickup", 0.5, 0.92);
    await sleep(1800);
  }
  const routeCheck = await ocrPhone(win, runDir, "tada-route-check");
  if (isTadaFareScreen(routeCheck.ocr) && !requestedDestination.test(routeCheck.ocr)) {
    throw new Error(
      `TADA reached a fare screen, but it does not show "${destinationText(requestBody)}".`,
    );
  }
  if (!isTadaFareScreen(routeCheck.ocr)) {
    throw new Error("TADA did not reach fare selection after choosing the destination.");
  }
}

async function prepareGrabDemo(win, runDir, requestBody) {
  let initial = await ocrPhone(win, runDir, "grab-pre-route");
  const onGrabHome = /\b(?:Transport|Food|Express|Mart|Dine Out|PayLater|Chope|More)\b/i.test(initial.ocr);
  if (onGrabHome || !/Where\s*to\??/i.test(initial.ocr)) {
    await tapTextOrFallback(
      win,
      runDir,
      "grab-transport-entry",
      /Transport/i,
      { minY: 0.12, maxY: 0.4 },
      { x: 0.15, y: 0.23 },
    );
    await sleep(1100);
    initial = await ocrPhone(win, runDir, "grab-transport-page");
  }
  if (/(JustGrab|GrabCar|\bBook\b|Choose this ride|S\$)/i.test(initial.ocr)) {
    return;
  }
  if (!/Where\s*to\??|Transport/i.test(initial.ocr)) {
    throw new Error("Grab opened on an unknown screen.");
  }

  await tapInputField(
    win,
    runDir,
    "grab-open-where-to-input",
    /Where\s*to\??/i,
    { minY: 0.24, maxY: 0.34, prefer: "top" },
    { x: 0.43, y: 0.29 },
  );
  await sleep(500);
  await pasteText(destinationText(requestBody));
  await sleep(1200);

  let destinationScreen = await ocrPhoneItems(win, runDir, "grab-destination-suggestion");
  if (isGrabTransportLanding(destinationScreen.ocr)) {
    await tapInputField(
      win,
      runDir,
      "grab-open-where-to-input-retry",
      /Where\s*to\??/i,
      { minY: 0.24, maxY: 0.34, prefer: "top" },
      { x: 0.43, y: 0.29 },
    );
    await sleep(700);
    await pasteText(destinationText(requestBody));
    await sleep(1400);
    destinationScreen = await ocrPhoneItems(win, runDir, "grab-destination-suggestion-retry");
  }
  if (isGrabTransportLanding(destinationScreen.ocr)) {
    throw new Error("Grab destination input did not open; stopped before tapping a recent drop-off.");
  }
  const destinationMatch = findTextItem(destinationScreen.items, destinationPattern(requestBody), { minY: 0.2 });
  if (destinationMatch) {
    await tapRelative(win, destinationMatch.center.x, destinationMatch.center.y);
  } else {
    await tapRelative(win, 0.36, 0.42);
  }
  await sleep(2200);

  const pickup = await ocrPhone(win, runDir, "grab-pickup-confirm");
  if (/Choose this pickup|Pick\s*up at\?|Pick Up & Drop Off Point/i.test(pickup.ocr)) {
    await tapTextOrFallback(
      win,
      runDir,
      "grab-choose-current-pickup",
      /Choose this pickup/i,
      { minY: 0.75, prefer: "bottom" },
      { x: 0.5, y: 0.91 },
    );
    await sleep(2200);
    return;
  }
  if (!/(JustGrab|GrabCar|\bBook\b|S\$)/i.test(pickup.ocr)) {
    throw new Error("Grab did not reach pickup confirmation or fare selection.");
  }
}

function extractPrice(ocrText) {
  const skipLine = /\b(off|promo|cashback|voucher|reward|discount|finance|wallet|worth|prize|gadget)\b/i;
  const matches = ocrText
    .split("\n")
    .filter((line) => !skipLine.test(line))
    .flatMap((line) => [
      ...line.matchAll(/(?:S\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi),
      ...line.matchAll(/\b([0-9]+(?:\.[0-9]{1,2})?)\s*SGD\b/gi),
    ])
    .map((match) => Number.parseFloat(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 5 && value <= 120);
  if (matches.length === 0) {
    return null;
  }
  return Math.min(...matches);
}

async function openAndPrepareProvider(win, runDir, provider, requestBody) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await openPhoneApp(win, provider, runDir);
      await provider.prepare?.(win, runDir, requestBody);
      return;
    } catch (error) {
      if (attempt > 0) {
        throw error;
      }
      await killForegroundPhoneApp(win);
    }
  }
}

function selectedRideProviders(requestBody) {
  const requested = Array.isArray(requestBody.providers)
    ? requestBody.providers.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : [];
  if (requested.length === 0) {
    return rideProviders;
  }
  const allowed = new Set(requested);
  return rideProviders.filter((provider) => allowed.has(provider.id) || allowed.has(provider.name.toLowerCase()));
}

async function liveQuotes(requestBody, onResult = () => {}) {
  const runDir = await mkdtemp(join(tmpdir(), "ride-router-live-"));
  const scans = [];
  const win = await phoneWindow();

  for (const provider of selectedRideProviders(requestBody)) {
    try {
      await openAndPrepareProvider(win, runDir, provider, requestBody);
      const imagePath = await capturePhoneImage(win, runDir, provider.id);
      scans.push(
        ocrImage(imagePath)
          .then((ocr) => {
            const price = extractPrice(ocr);
            const result = {
              id: provider.id,
              name: provider.name,
              price,
              status: price == null ? "opened-no-fare-detected" : "fare-detected",
              screenshot: imagePath,
              ocr: ocr.split("\n").slice(0, 80),
            };
            onResult(result);
            return result;
          })
          .catch((error) => {
            const result = {
              id: provider.id,
              name: provider.name,
              price: null,
              status: "ocr-failed",
              screenshot: imagePath,
              error: error instanceof Error ? error.message : String(error),
            };
            onResult(result);
            return result;
          }),
      );
    } catch (error) {
      const result = {
        id: provider.id,
        name: provider.name,
        price: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      onResult(result);
      scans.push(Promise.resolve(result));
    }
  }
  const results = await Promise.all(scans);

  return {
    destination: requestBody.destination ?? "",
    pickup: requestBody.pickup ?? "",
    runDir,
    results,
  };
}

function startLiveQuoteJob(requestBody) {
  const id = String(nextLiveQuoteJobId++);
  const job = {
    id,
    status: "running",
    destination: requestBody.destination ?? "",
    pickup: requestBody.pickup ?? "",
    runDir: null,
    results: [],
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  liveQuoteJobs.set(id, job);

  liveQuotes(requestBody, (result) => {
    const index = job.results.findIndex((item) => item.id === result.id);
    if (index >= 0) {
      job.results[index] = result;
    } else {
      job.results.push(result);
    }
    job.updatedAt = new Date().toISOString();
  })
    .then((payload) => {
      job.status = "complete";
      job.runDir = payload.runDir;
      job.results = payload.results;
      job.updatedAt = new Date().toISOString();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
    });

  return job;
}

async function bookProvider(requestBody) {
  const providerId = String(requestBody.provider ?? "").trim().toLowerCase();
  const provider = rideProviders.find((item) => item.id === providerId || item.name.toLowerCase() === providerId);
  if (!provider) {
    throw new Error("Unknown ride provider.");
  }

  const runDir = await mkdtemp(join(tmpdir(), "ride-router-book-"));
  const win = await phoneWindow();
  await openAndPrepareProvider(win, runDir, provider, requestBody);

  const tappedTexts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actionScreen = await ocrPhoneItems(win, runDir, `${provider.id}-book-action-${attempt + 1}`);
    const finalAction = findTextItem(actionScreen.items, finalBookingAction, { minY: 0.55, prefer: "bottom" });
    if (finalAction) {
      await tapRelative(win, finalAction.center.x, finalAction.center.y);
      await sleep(1500);
      const after = await ocrPhone(win, runDir, `${provider.id}-book-after-tap`);
      return {
        provider: provider.id,
        status: "booking-action-tapped",
        runDir,
        tappedText: finalAction.item.text,
        tappedTexts,
        screenshot: after.imagePath,
        ocr: after.ocr.split("\n").slice(0, 80),
      };
    }

    const selectionAction = findTextItem(actionScreen.items, rideSelectionAction, { minY: 0.55, prefer: "bottom" });
    if (!selectionAction) {
      return {
        provider: provider.id,
        status: "booking-action-not-found",
        runDir,
        tappedTexts,
        ocr: actionScreen.ocr.split("\n").slice(0, 80),
      };
    }
    await tapRelative(win, selectionAction.center.x, selectionAction.center.y);
    tappedTexts.push(selectionAction.item.text);
    await sleep(1500);
  }

  return {
    provider: provider.id,
    status: "booking-action-not-found",
    runDir,
    tappedTexts,
    ocr: [],
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "POST" && url.pathname === "/api/live-quotes") {
    try {
      const body = await readJsonBody(request);
      const job = startLiveQuoteJob(body);
      response.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(job));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/book-provider") {
    try {
      const body = await readJsonBody(request);
      const confirmed =
        request.headers["x-ride-router-booking-confirmed"] === "yes" &&
        body.confirmBooking === true;
      if (!confirmed) {
        response.writeHead(428, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "Booking requires an explicit confirmation." }));
        return;
      }

      const result = await bookProvider(body);
      const statusCode = result.status === "booking-action-tapped" ? 200 : 409;
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/live-quotes/")) {
    const id = url.pathname.split("/").at(-1);
    const job = id ? liveQuoteJobs.get(id) : null;
    if (!job) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Live quote job not found." }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(job));
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = normalize(join(root, pathname));

  if (!file.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": types.get(extname(file)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  const urls = [`http://localhost:${port}`, ...localAddresses().map((address) => `http://${address}:${port}`)];
  console.log("Ride Router running:");
  for (const url of urls) {
    console.log(`  ${url}`);
  }
  console.log("Open the LAN URL from your iPhone. Use manual pickup if Safari blocks GPS over HTTP.");
});
