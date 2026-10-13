const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const AUDIO_BITRATES = new Set([128, 192, 256, 320]);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INFO_BYTES = 12 * 1024 * 1024;
const MAX_SEARCH_QUERY_LENGTH = 100;
const DOWNLOAD_JOBS = new Map();
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function searchYouTube(request, response) {
  const query = new URL(request.url, "http://localhost").searchParams.get("q")?.trim() || "";
  if (!query || query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw Object.assign(new Error("Enter a search of 1 to 100 characters."), { status: 400 });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("YouTube search needs an API key. Set YOUTUBE_API_KEY and restart the local server."), { status: 503 });
  }

  const apiUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  apiUrl.searchParams.set("part", "snippet");
  apiUrl.searchParams.set("type", "video");
  apiUrl.searchParams.set("maxResults", "10");
  apiUrl.searchParams.set("safeSearch", "moderate");
  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("key", apiKey);

  let apiResponse;
  try {
    apiResponse = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw Object.assign(new Error("Could not connect to YouTube search. mommy and daddy didn't pay for the wifi bill."), { status: 502 });
  }

  let payload;
  try {
    payload = await apiResponse.json();
  } catch {
    throw Object.assign(new Error("YouTube search returned an unreadable response."), { status: 502 });
  }

  if (!apiResponse.ok) {
    const reasons = payload.error?.errors?.map((item) => item.reason) || [];
    if (apiResponse.status === 403 && reasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded"].includes(reason))) {
      throw Object.assign(new Error("YouTube search API quota exceeded. Try again later."), { status: 429 });
    }
    if (apiResponse.status === 403) {
      throw Object.assign(new Error("YouTube Data API rejected the key. Check that it is valid and YouTube Data API v3 is enabled."), { status: 502 });
    }
    throw Object.assign(new Error(`YouTube search failed (HTTP ${apiResponse.status}).`), { status: 502 });
  }

  const videos = (Array.isArray(payload.items) ? payload.items : [])
    .filter((item) => /^[\w-]{11}$/.test(item.id?.videoId || ""))
    .map((item) => ({
      id: item.id.videoId,
      title: String(item.snippet?.title || "YouTube video"),
      channel: String(item.snippet?.channelTitle || ""),
      thumbnail: `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg`,
    }));
  sendJson(response, 200, { videos });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error("Request body has a fat ass, tf are u downloading.."), { status: 413 }));
        request.resume();
      }
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function parseEta(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

function parseProgressLine(line) {
  if (/\[(?:Merger|ExtractAudio|VideoRemuxer)\]/.test(line)) {
    return { stage: "finishing", percent: 100, etaSeconds: null };
  }
  const match = line.match(/FRAME_PROGRESS:\s*([^|]+)\|([^|]+)\|(.+)/);
  if (!match) return null;
  const percent = Number.parseFloat(match[1].replace("%", "").trim());
  if (!Number.isFinite(percent)) return null;
  return {
    stage: "downloading",
    percent: Math.min(100, Math.max(0, percent)),
    etaSeconds: parseEta(match[2]),
  };
}

function runYtDlp(args, { timeoutMs = 120_000, maxOutputBytes = MAX_INFO_BYTES, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let progressBuffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("yt-dlp took too long to respond."));
    }, timeoutMs);

    function finish(error, output) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    function readProgress(chunk) {
      if (!onProgress) return;
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const progress = parseProgressLine(line);
        if (progress) onProgress(progress);
      }
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      readProgress(chunk);
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        child.kill();
        finish(new Error("yt-dlp returned too much metadata."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      readProgress(chunk);
      if (Buffer.byteLength(stderr) > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(Object.assign(new Error("yt-dlp was not found. Install yt-dlp and make sure it is available on PATH."), { status: 503 }));
      } else {
        finish(error);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(Object.assign(new Error(stderr.trim() || `yt-dlp exited with code ${code}.`), { status: 422 }));
        return;
      }
      finish(null, stdout);
    });
  });
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatInfo(info) {
  const bestByQuality = new Map();
  for (const format of info.formats || []) {
    if (
      !format.vcodec
      || format.vcodec === "none"
      || !format.height
      || !/^[\w.-]+$/.test(String(format.format_id))
    ) continue;

    const fps = Number(format.fps) || null;
    const key = `${format.height}-${fps}`;
    const existing = bestByQuality.get(key);
    const bitrate = Number(format.tbr) || 0;
    if (!existing || bitrate > existing.bitrate) {
      bestByQuality.set(key, {
        id: String(format.format_id),
        height: Number(format.height),
        fps,
        bitrate,
        codec: String(format.vcodec).split(".")[0].toUpperCase(),
        hasAudio: Boolean(format.acodec && format.acodec !== "none"),
        filesize: humanSize(Number(format.filesize) || Number(format.filesize_approx)),
      });
    }
  }

  const formats = [...bestByQuality.values()]
    .sort((a, b) => b.height - a.height || b.fps - a.fps)
    .map(({ id, height, fps, codec, hasAudio, filesize }) => ({
      id,
      resolution: `${height}p`,
      fps,
      codec,
      hasAudio,
      filesize,
    }));

  return {
    id: String(info.id || ""),
    title: String(info.title || "YouTube video"),
    duration: Number(info.duration) || null,
    thumbnail: typeof info.thumbnail === "string" ? info.thumbnail : "",
    formats,
  };
}

async function analyze(url) {
  const output = await runYtDlp(["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url]);
  let info;
  try {
    info = JSON.parse(output);
  } catch {
    throw Object.assign(new Error("Could not read video information from yt-dlp."), { status: 502 });
  }
  return formatInfo(info);
}

function scheduleJobCleanup(job, delay = 30 * 60 * 1000) {
  clearTimeout(job.cleanupTimer);
  job.cleanupTimer = setTimeout(async () => {
    if (job.directory) {
      await fsp.rm(job.directory, { recursive: true, force: true });
      job.directory = null;
    }
    DOWNLOAD_JOBS.delete(job.id);
  }, delay);
  job.cleanupTimer.unref();
}

async function prepareDownload(job, body) {
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isYouTubeUrl(url)) throw Object.assign(new Error("What the fuck did bro type"), { status: 400 });
  if (body.kind !== "mp4" && body.kind !== "mp3") {
    throw Object.assign(new Error("Choose MP4 video or MP3 audio."), { status: 400 });
  }

  const info = await analyze(url);
  let args;
  let extension;
  if (body.kind === "mp4") {
    const selected = info.formats.find((format) => format.id === body.formatId);
    if (!selected) throw Object.assign(new Error("Youtube only dumb ass."), { status: 400 });
    const selector = selected.hasAudio
      ? selected.id
      : `${selected.id}+bestaudio[ext=m4a]/${selected.id}+bestaudio/${selected.id}`;
    args = ["--no-playlist", "--no-warnings", "--newline", "--no-colors", "--progress-template", "download:FRAME_PROGRESS:%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s", "--progress-delta", "1", "--merge-output-format", "mp4", "--remux-video", "mp4", "-f", selector];
    extension = "mp4";
  } else {
    const bitrate = Number(body.bitrate);
    if (!AUDIO_BITRATES.has(bitrate)) throw Object.assign(new Error("Choose a supported MP3 bitrate."), { status: 400 });
    args = ["--no-playlist", "--no-warnings", "--newline", "--no-colors", "--progress-template", "download:FRAME_PROGRESS:%(progress._percent_str)s|%(progress._eta_str)s|%(progress._speed_str)s", "--progress-delta", "1", "-f", "bestaudio", "-x", "--audio-format", "mp3", "--audio-quality", String(bitrate)];
    extension = "mp3";
  }

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "frame-download-"));
  job.directory = directory;
  job.extension = extension;
  job.state = "downloading";
  job.progress = { stage: "downloading", percent: 0, etaSeconds: null };
  scheduleJobCleanup(job);
  try {
    args.push("-o", path.join(directory, "%(title).120B.%(ext)s"), url);
    await runYtDlp(args, {
      timeoutMs: 30 * 60 * 1000,
      maxOutputBytes: 2 * 1024 * 1024,
      onProgress: (progress) => {
        job.progress = progress;
        if (progress.stage === "finishing") job.state = "finishing";
      },
    });
    const files = await fsp.readdir(directory);
    const filename = files.find((entry) => path.extname(entry).toLowerCase() === `.${extension}`);
    if (!filename) throw Object.assign(new Error("yt-dlp finished without producing the requested file."), { status: 500 });
    job.filename = filename;
    job.state = "ready";
    job.progress = { stage: "ready", percent: 100, etaSeconds: 0 };
  } catch (error) {
    job.state = "error";
    job.error = error.message || "The download could not be prepared.";
    job.progress = { stage: "error", percent: 0, etaSeconds: null };
    await fsp.rm(directory, { recursive: true, force: true });
    job.directory = null;
    scheduleJobCleanup(job, 10 * 60 * 1000);
  }
}

async function startDownload(request, response) {
  const body = await readJson(request);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!isYouTubeUrl(url)) throw Object.assign(new Error("Enter a valid HTTPS YouTube link."), { status: 400 });
  if (body.kind !== "mp4" && body.kind !== "mp3") {
    throw Object.assign(new Error("Choose MP4 video or MP3 audio."), { status: 400 });
  }
  if (body.kind === "mp3" && !AUDIO_BITRATES.has(Number(body.bitrate))) {
    throw Object.assign(new Error("Choose a supported MP3 bitrate."), { status: 400 });
  }

  const job = {
    id: randomUUID(),
    state: "starting",
    progress: { stage: "starting", percent: 0, etaSeconds: null },
    directory: null,
    filename: null,
    error: null,
    cleanupTimer: null,
  };
  DOWNLOAD_JOBS.set(job.id, job);
  scheduleJobCleanup(job);
  prepareDownload(job, body).catch((error) => {
    job.state = "error";
    job.error = error.message || "The download could not be prepared becuse yes.";
    job.progress = { stage: "error", percent: 0, etaSeconds: null };
    scheduleJobCleanup(job, 10 * 60 * 1000);
  });
  sendJson(response, 202, { id: job.id });
}

function findDownloadJob(value) {
  if (typeof value !== "string" || !/^[\da-f-]{36}$/i.test(value)) return null;
  return DOWNLOAD_JOBS.get(value) || null;
}

function getDownloadStatus(request, response) {
  const id = new URL(request.url, "http://localhost").searchParams.get("id");
  const job = findDownloadJob(id);
  if (!job) {
    sendJson(response, 404, { error: "This download has expired. Start it again." });
    return;
  }
  sendJson(response, 200, {
    state: job.state,
    progress: job.progress,
    ...(job.error ? { error: job.error } : {}),
  });
}

async function sendDownloadFile(request, response) {
  const id = new URL(request.url, "http://localhost").searchParams.get("id");
  const job = findDownloadJob(id);
  if (!job) throw Object.assign(new Error("This download has expired. Start it again."), { status: 404 });
  if (job.state !== "ready" || !job.directory || !job.filename) {
    throw Object.assign(new Error("This download is not ready yet."), { status: 409 });
  }

  const filePath = path.join(job.directory, job.filename);
  const stat = await fsp.stat(filePath);
  const extension = job.extension;
  clearTimeout(job.cleanupTimer);
  response.writeHead(200, {
    "Content-Type": extension === "mp4" ? "video/mp4" : "audio/mpeg",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${job.filename.replace(/[^\w.-]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  try {
    await pipeline(fs.createReadStream(filePath), response);
  } finally {
    await fsp.rm(job.directory, { recursive: true, force: true });
    DOWNLOAD_JOBS.delete(job.id);
  }
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  try {
    if (request.method === "GET" && pathname === "/api/search") {
      await searchYouTube(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/status") {
      const [ytDlp, ffmpeg] = await Promise.all([
        runYtDlp(["--version"], { timeoutMs: 5_000, maxOutputBytes: 1024 }).then(() => true).catch((error) => {
          if (error.status === 503) return false;
          throw error;
        }),
        new Promise((resolve, reject) => {
          const child = spawn("ffmpeg", ["-version"], { windowsHide: true, stdio: "ignore" });
          child.on("error", (error) => error.code === "ENOENT" ? resolve(false) : reject(error));
          child.on("close", (code) => resolve(code === 0));
        }),
      ]);
      sendJson(response, 200, { ytDlp, ffmpeg });
      return;
    }

    if (request.method === "POST" && pathname === "/api/info") {
      const body = await readJson(request);
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!isYouTubeUrl(url)) throw Object.assign(new Error("WHAT IS SO HARD TO UNDERSTAND, YOUTUBE ONLY."), { status: 400 });
      const info = await analyze(url);
      sendJson(response, 200, info);
      return;
    }

    if (request.method === "POST" && pathname === "/api/download") {
      await startDownload(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/download/status") {
      getDownloadStatus(request, response);
      return;
    }

    if (request.method === "GET" && pathname === "/api/download/file") {
      await sendDownloadFile(request, response);
      return;
    }

    if (pathname === "/api/info" || pathname === "/api/download") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { error: "This API endpoint requires a POST request." });
      return;
    }

    if (pathname === "/api/search") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "This API endpoint requires a GET request." });
      return;
    }

    if (pathname === "/api/download/status" || pathname === "/api/download/file") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "This API endpoint requires a GET request." });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "API endpoint not found." });
      return;
    }

    if (request.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/app.js")) {
      const filename = pathname === "/app.js" ? "app.js" : "index.html";
      const content = await fsp.readFile(path.join(ROOT, filename));
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filename)],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
      response.end(content);
      return;
    }

    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, error.status || 500, { error: error.message || "An error occurred..........idk why tho" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Frame is running at http://127.0.0.1:${PORT}`);
});
