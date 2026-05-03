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

async function keyCode(code, modifiers = "") {
  const suffix = modifiers ? ` using ${modifiers}` : "";
  await osascript(["-e", `tell application "System Events" to key code ${code}${suffix}`]);
}

async function goHome() {
  await activatePhone();
  await keyCode(53).catch(() => {});
  await sleep(100);
  await keyCode(18, "command down");
  await sleep(500);
}

async function openTravelFolder() {
  const win = await phoneWindow();
  await clickPoint(win.x + win.width * 0.64, win.y + win.height * 0.38);
  await sleep(350);
}

async function openPhoneApp(provider) {
  const appPositions = {
    Gojek: { x: 0.27, y: 0.41 },
    "CDG Zig": { x: 0.5, y: 0.41 },
    TADA: { x: 0.72, y: 0.41 },
    Grab: { x: 0.27, y: 0.54 },
  };
  const position = appPositions[provider.searchName];
  if (!position) {
    throw new Error(`Unknown phone app position: ${provider.searchName}`);
  }

  await goHome();
  await openTravelFolder();
  const win = await phoneWindow();
  await clickPoint(win.x + win.width * position.x, win.y + win.height * position.y);
  await sleep(provider.waitMs);
}

async function capturePhoneImage(runDir, providerId) {
  const win = await phoneWindow();
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

async function liveQuotes(requestBody) {
  const providers = [
    { id: "gojek", name: "Gojek", searchName: "Gojek", waitMs: 2200 },
    { id: "grab", name: "Grab", searchName: "Grab", waitMs: 2200 },
    { id: "cdg", name: "CDG Zig", searchName: "CDG Zig", waitMs: 2400 },
    { id: "tada", name: "TADA", searchName: "TADA", waitMs: 2200 },
  ];
  const runDir = await mkdtemp(join(tmpdir(), "ride-router-live-"));
  const scans = [];

  for (const provider of providers) {
    try {
      await openPhoneApp(provider);
      const imagePath = await capturePhoneImage(runDir, provider.id);
      scans.push(
        ocrImage(imagePath)
          .then((ocr) => {
            const price = extractPrice(ocr);
            return {
              id: provider.id,
              name: provider.name,
              price,
              status: price == null ? "opened-no-fare-detected" : "fare-detected",
              screenshot: imagePath,
              ocr: ocr.split("\n").slice(0, 80),
            };
          })
          .catch((error) => ({
            id: provider.id,
            name: provider.name,
            price: null,
            status: "ocr-failed",
            screenshot: imagePath,
            error: error instanceof Error ? error.message : String(error),
          })),
      );
    } catch (error) {
      scans.push(
        Promise.resolve({
          id: provider.id,
          name: provider.name,
          price: null,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
      const result = await liveQuotes(body);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
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
