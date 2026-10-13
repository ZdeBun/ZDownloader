const form = document.querySelector("#url-form");
const pasteButton = document.querySelector("#paste-button");
const searchButton = document.querySelector("#search-button");
const closeSearchButton = document.querySelector("#close-search-button");
const searchPanel = document.querySelector("#search-panel");
const searchForm = document.querySelector("#youtube-search-form");
const searchQuery = document.querySelector("#youtube-search-query");
const searchSubmitButton = document.querySelector("#youtube-search-submit");
const searchMessage = document.querySelector("#search-message");
const searchResults = document.querySelector("#search-results");
const resetButton = document.querySelector("#reset-button");
const urlInput = document.querySelector("#video-url");
const analyzeButton = document.querySelector("#analyze-button");
const message = document.querySelector("#message");
const result = document.querySelector("#result");
const videoFormats = document.querySelector("#video-formats");
const audioFormats = document.querySelector("#audio-formats");
const downloadMp4 = document.querySelector("#download-mp4");
const downloadMp3 = document.querySelector("#download-mp3");
const tabs = [...document.querySelectorAll(".tab")];
const panels = {
  mp4: document.querySelector("#panel-mp4"),
  mp3: document.querySelector("#panel-mp3"),
};

let currentVideo = null;
let activeTab = "mp4";
let analysisRequestId = 0;
let searchRequestId = 0;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function showSearchMessage(text, isError = false) {
  searchMessage.textContent = text;
  searchMessage.classList.toggle("error", isError);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  const actions = button.closest(".download-actions");
  actions?.classList.toggle("is-preparing", busy);
  if (!busy) actions?.querySelector(".download-estimate").replaceChildren();
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
}

function setDownloadEstimate(button, text) {
  button.closest(".download-actions").querySelector(".download-estimate").textContent = text;
}

function formatRemaining(seconds) {
  if (seconds < 1) return "less than a second";
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours} hr ${minutes % 60} min`;
  }
  if (minutes > 0) return `${minutes} min ${remainder} sec`;
  return `${remainder} sec`;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function selectTab(name) {
  activeTab = name;
  for (const tab of tabs) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.classList.toggle("hidden", key !== name);
  }
}

function renderVideoFormats(formats) {
  videoFormats.replaceChildren();
  downloadMp4.disabled = formats.length === 0;
  if (formats.length === 0) {
    videoFormats.innerHTML = '<div class="empty-state">No downloadable MP4 video formats were found.</div>';
    return;
  }

  formats.forEach((format, index) => {
    const option = document.createElement("div");
    option.className = "format-option";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "video-format";
    radio.value = format.id;
    radio.checked = index === 0;

    const copy = document.createElement("span");
    const name = document.createElement("span");
    name.className = "option-name";
    name.textContent = format.resolution;
    const detail = document.createElement("span");
    detail.className = "option-detail";
    detail.textContent = format.fps ? `${format.fps} FPS · ${format.codec}` : format.codec;
    copy.append(name, detail);
    label.append(radio, copy);
    option.append(label);

    if (format.filesize) {
      const size = document.createElement("span");
      size.className = "option-size";
      size.textContent = format.filesize;
      option.append(size);
    }
    videoFormats.append(option);
  });
}

function renderAudioFormats() {
  audioFormats.replaceChildren();
  [320, 256, 192, 128].forEach((bitrate, index) => {
    const option = document.createElement("div");
    option.className = "format-option";
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "audio-bitrate";
    radio.value = String(bitrate);
    radio.checked = index === 0;

    const copy = document.createElement("span");
    const name = document.createElement("span");
    name.className = "option-name";
    name.textContent = `${bitrate} kbps`;
    const detail = document.createElement("span");
    detail.className = "option-detail";
    detail.textContent = index === 0 ? "Highest quality" : "MP3 audio";
    copy.append(name, detail);
    label.append(radio, copy);
    option.append(label);
    audioFormats.append(option);
  });
}

async function fetchApi(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Could not connect to the local downloader. Make sure the server is running, then try again.");
    }
    throw error;
  }
}

async function readJsonResponse(response) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    if (!body.trim()) {
      throw new Error(`The downloader returned an empty response (HTTP ${response.status}). Restart the local server and try again.`);
    }
    throw new Error(`The downloader returned an invalid response (HTTP ${response.status}). Restart the local server and try again.`);
  }
}

async function requestJson(url, options) {
  const response = await fetchApi(url, options);
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}

async function readDownloadBlob(response, button) {
  const totalBytes = Number(response.headers.get("Content-Length"));
  if (!response.body || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return response.blob();
  }

  const reader = response.body.getReader();
  const chunks = [];
  const startedAt = performance.now();
  let receivedBytes = 0;
  let lastUpdate = startedAt;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    const now = performance.now();
    if (now - lastUpdate >= 500 && receivedBytes < totalBytes) {
      const bytesPerSecond = receivedBytes / ((now - startedAt) / 1000);
      const eta = bytesPerSecond > 0 ? (totalBytes - receivedBytes) / bytesPerSecond : null;
      setDownloadEstimate(button, eta === null
        ? "Sending file…"
        : `Sending file · about ${formatRemaining(eta)} left`);
      lastUpdate = now;
    }
  }
  return new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestId = ++analysisRequestId;
  const url = urlInput.value.trim();
  result.classList.add("hidden");
  currentVideo = null;
  showMessage("Checking available formats…");
  setBusy(analyzeButton, true, "Checking…");

  try {
    const data = await requestJson("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (requestId !== analysisRequestId) return;
    currentVideo = { url, id: data.id };
    document.querySelector("#video-title").textContent = data.title;
    document.querySelector("#video-duration").textContent = formatDuration(data.duration);
    const thumbnail = document.querySelector("#thumbnail");
    if (data.thumbnail) {
      thumbnail.src = data.thumbnail;
      thumbnail.classList.remove("hidden");
    } else {
      thumbnail.removeAttribute("src");
      thumbnail.classList.add("hidden");
    }
    renderVideoFormats(data.formats);
    renderAudioFormats();
    selectTab(activeTab);
    result.classList.remove("hidden");
    showMessage("");
  } catch (error) {
    if (requestId === analysisRequestId) showMessage(error.message, true);
  } finally {
    if (requestId === analysisRequestId) setBusy(analyzeButton, false);
  }
});

resetButton.addEventListener("click", () => {
  analysisRequestId += 1;
  form.reset();
  currentVideo = null;
  result.classList.add("hidden");
  document.querySelector("#video-title").textContent = "";
  document.querySelector("#video-duration").textContent = "";
  const thumbnail = document.querySelector("#thumbnail");
  thumbnail.removeAttribute("src");
  thumbnail.classList.add("hidden");
  renderVideoFormats([]);
  renderAudioFormats();
  selectTab("mp4");
  setBusy(analyzeButton, false);
  showMessage("Only videos available to this tool can be processed.");
  urlInput.focus();
});

async function download(kind) {
  if (!currentVideo) return;
  const button = kind === "mp4" ? downloadMp4 : downloadMp3;
  const selected = document.querySelector(`input[name="${kind === "mp4" ? "video-format" : "audio-bitrate"}"]:checked`);
  if (!selected) {
    showMessage("Choose a format before downloading.", true);
    return;
  }

  setBusy(button, true, "Preparing…");
  setDownloadEstimate(button, "Starting download…");
  showMessage("Preparing your download…");
  try {
    const response = await fetchApi("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: currentVideo.url,
        kind,
        formatId: kind === "mp4" ? selected.value : undefined,
        bitrate: kind === "mp3" ? Number(selected.value) : undefined,
      }),
    });
    if (!response.ok) {
      const payload = await readJsonResponse(response);
      throw new Error(payload.error || "Fuck you i don't want to download :) (can't be prepared) ");
    }

    const { id } = await readJsonResponse(response);
    let jobStatus;
    do {
      jobStatus = await requestJson(`/api/download/status?id=${encodeURIComponent(id)}`);
      if (jobStatus.state === "error") throw new Error(jobStatus.error || "Fuck you i don't want to download :) (can't be prepared)");
      if (jobStatus.state === "ready") break;

      if (jobStatus.state === "downloading") {
        const { percent, etaSeconds } = jobStatus.progress;
        setDownloadEstimate(button, etaSeconds === null
          ? `${Math.round(percent)}% · estimating time left`
          : `${Math.round(percent)}% · about ${formatRemaining(etaSeconds)} left`);
      } else if (jobStatus.state === "finishing") {
        setDownloadEstimate(button, "Finishing file…");
      } else {
        setDownloadEstimate(button, "Starting download…");
      }
      await delay(1000);
    } while (true);

    setDownloadEstimate(button, "Sending file…");
    const fileResponse = await fetchApi(`/api/download/file?id=${encodeURIComponent(id)}`);
    if (!fileResponse.ok) {
      const payload = await readJsonResponse(fileResponse);
      throw new Error(payload.error || "Fuck you i don't want to download :) (can't be retrieved)");
    }

    const blob = await readDownloadBlob(fileResponse, button);
    const disposition = fileResponse.headers.get("Content-Disposition") || "";
    const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const fallbackFilename = disposition.match(/filename="([^"]+)"/);
    const match = encodedFilename || fallbackFilename;
    let filename = match ? match[1] : `${currentVideo.id}.${kind}`;
    if (encodedFilename) filename = decodeURIComponent(filename);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    showMessage("Your download is ready.");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setBusy(button, false);
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.id === "tab-mp4" ? "mp4" : "mp3"));
});
downloadMp4.addEventListener("click", () => download("mp4"));
downloadMp3.addEventListener("click", () => download("mp3"));

renderAudioFormats();
selectTab("mp4");

pasteButton.addEventListener("click", async () => {
  if (!navigator.clipboard?.readText) {
    showMessage("Clipboard access is unavailable. Paste the link with Ctrl+V instead.", true);
    urlInput.focus();
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      showMessage("mf you didn't copy anything", true);
    } else {
      urlInput.value = text.trim();
      showMessage("Link pasted. Click Download to check available formats.");
    }
    urlInput.focus();
  } catch {
    showMessage("Could not read the clipboard. GIVE ME ACCESS NOW, or yk you can use Ctrl+V.", true);
    urlInput.focus();
  }
});

searchButton.addEventListener("click", () => {
  searchPanel.classList.toggle("hidden");
  const isOpen = !searchPanel.classList.contains("hidden");
  searchButton.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) searchQuery.focus();
});

closeSearchButton.addEventListener("click", () => {
  searchPanel.classList.add("hidden");
  searchButton.setAttribute("aria-expanded", "false");
  searchButton.focus();
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const requestId = ++searchRequestId;
  const query = searchQuery.value.trim();
  searchResults.replaceChildren();
  showSearchMessage("Searching YouTube…");
  setBusy(searchSubmitButton, true, "Searching for shit…");

  try {
    const data = await requestJson(`/api/search?q=${encodeURIComponent(query)}`);
    if (requestId !== searchRequestId) return;
    if (data.videos.length === 0) {
      showSearchMessage("No videos found. Try a different search.");
      return;
    }

    showSearchMessage(`${data.videos.length} videos found. Select one to load its formats.`);
    for (const video of data.videos) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-result";
      const thumbnail = document.createElement("img");
      thumbnail.src = video.thumbnail;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      const copy = document.createElement("span");
      copy.className = "search-result-copy";
      const title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = video.title;
      const channel = document.createElement("span");
      channel.className = "search-result-channel";
      channel.textContent = video.channel;
      copy.append(title, channel);
      item.append(thumbnail, copy);
      item.addEventListener("click", () => {
        urlInput.value = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
        searchPanel.classList.add("hidden");
        searchButton.setAttribute("aria-expanded", "false");
        form.requestSubmit();
      });
      searchResults.append(item);
    }
  } catch (error) {
    if (requestId === searchRequestId) showSearchMessage(error.message, true);
  } finally {
    if (requestId === searchRequestId) setBusy(searchSubmitButton, false);
  }
});

requestJson("/api/status")
  .then((status) => {
    if (!status.ytDlp || !status.ffmpeg) {
      const missing = [
        !status.ytDlp && "yt-dlp",
        !status.ffmpeg && "FFmpeg",
      ].filter(Boolean).join(" and ");
      showMessage(`Install ${missing} and make sure it is available on PATH to process videos.`, true);
    }
  })
  .catch((error) => showMessage(error.message, true));
