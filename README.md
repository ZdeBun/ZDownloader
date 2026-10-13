# Run Frame on this computer

Frame is a local application. It needs to be served by its Node.js server; do not
open `index.html` directly or expect a search engine to host it.

## Requirements

- Node.js
- `yt-dlp`
- `ffmpeg` (needed for MP3 conversion and some MP4 downloads)
- A YouTube Data API v3 key (needed for in-page YouTube search)

On Windows, the launcher installs any missing tools using WinGet. If WinGet is
not available, install Node.js, yt-dlp, and FFmpeg manually and add them to
`PATH`.

## Start on Windows

Download the repository as a ZIP from GitHub and extract the entire folder.
Double-click [`start-local.bat`](./start-local.bat) to launch the app. On first
run, it uses WinGet to install Node.js LTS, yt-dlp, and FFmpeg if they are
missing. Windows may ask you to approve an installation. Keep the minimized
server window open while using the site; close it to stop the server.

Do not use a `.lnk` shortcut copied from another computer: Windows shortcuts
store the original computer's file path and are not portable in a GitHub ZIP.
The local `Zdowenloader APP.lnk` shortcut is only for the computer where it was
created. It is excluded from Git by [`.gitignore`](./.gitignore). Run the batch
file from the extracted folder instead.

The server listens on `127.0.0.1`, so it is available only from this computer.
The page displays an error if `yt-dlp` or `ffmpeg` is missing or not on `PATH`.

## Enable in-page YouTube search

The search panel uses YouTube's official Data API. Create an API key in Google
Cloud, enable **YouTube Data API v3** for its project, and restrict the key to
that API. Do not put the key in `app.js` or share it.

On Windows, add a user environment variable named `YOUTUBE_API_KEY` containing
the key. Search Windows for **Edit environment variables for your account**, add
the variable under **User variables**, then close and reopen the downloader so
the server receives it. The key is read by the local server and is not sent to
the browser. Without the key, video downloads from pasted links still work, but
the in-page search displays a setup error.

Click **Search manually** to open the panel, search for a video, then select a
result to load its downloadable formats.