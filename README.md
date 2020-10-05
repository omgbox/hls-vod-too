hls-vod-too 📺
=======

HTTP Live Streaming with on-the-fly encoding of any video file. Supports modern browsers through the use of [hls.js](https://github.com/video-dev/hls.js/).

Differences from the original [hls-vod](https://github.com/mifi/hls-vod)
-------------------------------------------------------------------------

This is like a re-write of the orignal hls-vod. 

I certainly stole the main mechanism, the API and many implementation code from it, including the idea of using ffmpeg for transcoding, using Express.js for the middleware server and the web app. I copied a lot of code snippets too.

But as the differences (listed below) are huge, I decided to name this as a new package instead of sending changes to the original hls-vod.

- Advantages
  - Allows seeking immediately after loading a video.
    - With the original hls-vod, the progress bar only shows the parts of the video that has finished transcoding. You'll have to wait for the transcoding before jumping to a later time in the video. In this version, the progress bar immediately shows the full length of the video, so you can jump to any specific time of the video.
  - Supports multiple quality levels (1080p, 720p, etc.) by using a [master playlist](https://developer.apple.com/documentation/http_live_streaming/example_playlists_for_http_live_streaming/creating_a_master_playlist), which allows players to automatically switch between different qualities according to network conditions.
  - Detects if the format is likely to be directly playable in the browser. If so, offer the optional to play the video file directly, instead of transcoding and serving through HLS.
    - Modern browsers are capable of playing video files directly, with pretty good performance and full seeking functionality. HLS is unnecessaty in this case.
    - This can be disabled by `--no-short-circuit`. 
  - Supports multiple transcodings at the same time.
    - The max number of concurrent users can be specified by `--max-client-number`.
    - When multiple users play the same file (at the same quality level), the file will only be transcoded once. 
  - Better screenshots (preview).
    - Take screenshots evenly throughout the video, instead of just near the beginning of the video.
- Shortcomings
  - Not supporting VLC as backend. Only supports ffmpeg.
  - Legacy browsers won't be supported, as the code uses ES6 classes, web components, async generator functions, etc..
- Implementation differences
  - Server-side code uses TypeScript instead of JavaScript for better maintainability.
  - Eliminates the synchronous file IO, which is discouraged. Uses several features that requires newer version of Node (`withFileTypes` flag, async/await, etc.).
  - Uses bare hls.js instead of the mediaelement.js wrapper for frontend, which is more lightweight, and enables fine-tuning with HLS, but lacks fancy UI features.

Requirements
------------
- [node.js](https://nodejs.org/en/) (>= v10.12)
- [ffmpeg](https://ffmpeg.org/) (Tested on 4.1, must be built with libx264).
- Tested on Linux.

Installation
------------
```
npm i -g hls-vod-too
```

Running (with ffmpeg)
------------------------------
- Make sure you have node.js and ffmpeg in PATH
- `hls-vod --root-path /path/to/my/videos`
- Or: `hls-vod --transcoder-path /path/to/ffmpeg --root-path /path/to/my/videos`
- Browse to http://localhost:4040/

Arguments
---------
```
--root-path DIR - Root path allowed to read files in. Defaults to current directory.

--cache-path DIR - Where to write transcoded video cache. Defaults to OS temp dir.

--ffmpeg-binary-dir DIR - The directory to look for ffmpeg and ffprobe binaries. Needed if they are not in $PATH.

--no-short-circuit - Always playback through HLS, even when the file is directly playable in browsers.
```

For more arguments run it without arguments: `hls-vod-too`