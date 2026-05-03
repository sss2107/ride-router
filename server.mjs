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
  await tapRelative(win, 0.6, 0.375);
  await sleep(260);
}

async function openPhoneApp(win, provider) {
  const appPositions = {
    Gojek: { x: 0.29, y: 0.405 },
    "CDG Zig": { x: 0.5, y: 0.405 },
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

async function ocrPhone(win, runDir, name) {
  const imagePath = await capturePhoneImage(win, runDir, name);
  return { imagePath, ocr: await ocrImage(imagePath) };
}

function destinationText(requestBody) {
  return String(requestBody.destination ?? "Changi Green").trim() || "Changi Green";
}

async function prepareGojekDemo(win, runDir) {
  const initial = await ocrPhone(win, runDir, "gojek-pre-route");
  if (/(GoCar|Find driver|S\$)/i.test(initial.ocr)) {
    return;
  }

  await tapRelative(win, 0.44, 0.91);
  await sleep(1500);
  const check = await ocrPhone(win, runDir, "gojek-pre-confirm");
  if (/confirm pickup point/i.test(check.ocr)) {
    await tapRelative(win, 0.5, 0.935);
    await sleep(2600);
  }
}

async function prepareTadaDemo(win, runDir, requestBody) {
  const initial = await ocrPhone(win, runDir, "tada-pre-route");
  if (/(AnyTADA|TADA GO|Book|SGD)/i.test(initial.ocr)) {
    return;
  }

  await tapRelative(win, 0.32, 0.292);
  await sleep(500);
  await pasteText(destinationText(requestBody));
  await sleep(1000);
  await tapRelative(win, 0.35, 0.665);
  await sleep(1800);
  const confirm = await ocrPhone(win, runDir, "tada-pre-confirm");
  if (/confirm|set pickup location/i.test(confirm.ocr)) {
    await tapRelative(win, 0.5, 0.92);
    await sleep(1800);
  }
}

async function prepareGrabDemo(win, runDir, requestBody) {
  const initial = await ocrPhone(win, runDir, "grab-pre-route");
  if (/(JustGrab|GrabCar|Book|Choose this ride|S\$)/i.test(initial.ocr)) {
    return;
  }

  await tapRelative(win, 0.34, 0.295);
  await sleep(500);
  await pasteText(destinationText(requestBody));
  await sleep(1200);
  await tapRelative(win, 0.36, 0.42);
  await sleep(2200);
}

async function prepareCdgDemo(win, runDir) {
  const initial = await ocrPhone(win, runDir, "cdg-pre-route");
  if (/Done|Singapore Government Agency|Campaigns&Events|Change for Charity/i.test(initial.ocr)) {
    await tapRelative(win, 0.09, 0.15);
    await sleep(700);
    await openTravelFolder(win);
    await tapRelative(win, 0.5, 0.405);
    await sleep(1500);
  }
}

function extractPrice(ocrText) {
  const skipLine = /\b(off|promo|cashback|voucher|reward|discount|finance|wallet)\b/i;
  const matches = ocrText
    .split("\n")
    .filter((line) => !skipLine.test(line))
    .flatMap((line) => [...line.matchAll(/(?:S\$|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/gi)])
    .map((match) => Number.parseFloat(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 5 && value <= 120);
  if (matches.length === 0) {
    return null;
  }
  return Math.min(...matches);
}

async function liveQuotes(requestBody, onResult = () => {}) {
  const providers = [
    { id: "gojek", name: "Gojek", searchName: "Gojek", waitMs: 1300, prepare: prepareGojekDemo },
    { id: "grab", name: "Grab", searchName: "Grab", waitMs: 1400, prepare: prepareGrabDemo },
    { id: "tada", name: "TADA", searchName: "TADA", waitMs: 1200, prepare: prepareTadaDemo },
    { id: "cdg", name: "CDG Zig", searchName: "CDG Zig", waitMs: 1500, prepare: prepareCdgDemo },
  ];
  const runDir = await mkdtemp(join(tmpdir(), "ride-router-live-"));
  const scans = [];
  const win = await phoneWindow();

  for (const provider of providers) {
    try {
      await openPhoneApp(win, provider);
      await provider.prepare?.(win, runDir, requestBody);
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
