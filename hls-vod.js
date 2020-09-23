#!/usr/bin/env node

const assert = require('assert');
const childProcess = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const { promisify } = require('util');
const EventEmitter = require('events');

// 3rd party
const fs = require('fs-extra');
const express = require('express');
const serveStatic = require('serve-static');
const bodyParser = require('body-parser');
const parseArgs = require('minimist');
const socketIo = require('socket.io');
const { runInContext } = require('vm');

const videoExtensions = ['.mp4', '.3gp2', '.3gp', '.3gpp', '.3gp2', '.amv', '.asf', '.avs', '.dat', '.dv', '.dvr-ms', '.f4v', '.m1v', '.m2p', '.m2ts', '.m2v', '.m4v', '.mkv', '.mod', '.mp4', '.mpe', '.mpeg1', '.mpeg2', '.divx', '.mpeg4', '.mpv', '.mts', '.mxf', '.nsv', '.ogg', '.ogm', '.mov', '.qt', '.rv', '.tod', '.trp', '.tp', '.vob', '.vro', '.wmv', '.web,', '.rmvb', '.rm', '.ogv', '.mpg', '.avi', '.mkv', '.wmv', '.asf', '.m4v', '.flv', '.mpg', '.mpeg', '.mov', '.vob', '.ts', '.webm'];
const audioExtensions = ['.mp3', '.aac', '.m4a'];

const qualityLevelPresets = {
    '1080p-extra': { resolution: 1080, videoBitrate: 14400, audioBitrate: 320 },
    '1080p': { resolution: 1080, videoBitrate: 9600,  audioBitrate: 224 },
    '720p': { resolution: 720, videoBitrate: 4800,  audioBitrate: 160 },
    '480p': { resolution: 480, videoBitrate: 2400,  audioBitrate: 128 },
    '360p': { resolution: 360, videoBitrate: 1200,  audioBitrate: 112 }
};
Object.values(qualityLevelPresets).forEach(v => {
    v.bandwidth = (preset.videoBitrate + preset.audioBitrate) * 1.05; // 5% estimated container overhead.
});

const ffprobeTimeout = 30 * 1000; // millisecs.
const processCleanupTimeout = 6 * 60 * 60 * 1000; // millisecs.

// Those formats can be supported by the browser natively: transcoding may not be needed for them.
// Listed in https://www.chromium.org/audio-video; change accordingly if you are mainly targeting another browser.
const nativeSupportedFormats = {
    container: ['mov', 'mp4', 'webm', 'ogg'],
    video: ['h264','vp8', 'vp9',' theora'],
    audio: ['aac', 'mp3', 'vorbis', 'opus', 'pcm_u8', 'pcm_s16le', 'pcm_f32le', 'flac']
};

/**
 * Main entry point for a program instance. You can run multiple instances as long as they use different ports and output paths.
 * 
 * @param {Object.<string, string|boolean>} args command line arguments
 * @returns async function to clean up
 */
const main = async args => {
    const listenPort = parseInt(args['port']) || 4040;
    const rootPath = path.resolve(args['root-path'] || '.');
    const ffmpegBinaryDir = args['ffmpeg-binary-dir'] ? (args['ffmpeg-binary-dir'] + path.sep) : '';
    const outputPath = path.resolve(args['cache-path'] || path.join(os.tmpdir(), 'hls-vod-cache'));
	const debug = args['debug'];
	const videoMinBufferLength = parseInt(args['buffer-length']) || 30;
	const videoMaxBufferLength = videoMinBufferLength * 2;

	const toDiskPath = relPath => path.join(rootPath, path.join('/', relPath));

    const Run = (command, args, { timeout, cwd }) => {
        const processHandle = childProcess.spawn(
            ffmpegBinaryDir + command,
            args,
            { cwd: cwd || outputPath, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] }
		);

		Run.allChildProcesses.add(processHandle);
		processHandle.on('exit', () => Run.allChildProcesses.delete(processHandle));

		const promise = new Promise((res, rej) => {
			let timeoutRef;
			const onFinish = code => {
				clearTimeout(timeoutRef);
				res(code);
			};
			processHandle.on('exit', onFinish);
			timeoutRef = setTimeout(async () => {
				processHandle.removeListener('exit', onFinish);
				await Run.killProcess(processHandle);
				rej(new Error('Child process timeout.'));
			}, timeout || processCleanupTimeout);
		});

		const stdout = processHandle.stdout;

		const kill = () => Run.killProcess(processHandle);

		const result = async () => {
			let stdoutBuf = '';
			processHandle.stdout.on('data', data => { 
				stdoutBuf += data;
			});
			const code = await promise;
			if (code != 0) { throw new Error(`Process [${[command, ...args].join(' ')}] exited w/ status ${code}.`); }
			return stdoutBuf;
		};
		
        return { promise, stdout, kill, result };
	};

	Run.allChildProcesses = new Set();

	Run.killProcess = processToKill => new Promise(res => {
		processToKill.on('exit', res);
	
		processToKill.kill();
	
		setTimeout(() => processToKill.kill('SIGKILL'), 5000);
	});

	Run.killAll = () => Promise.all(Run.allChildProcesses.map(Run.killProcess));
	
	const Media = async relPath => {
		const log = (...params) => {
			if (debug) {
				console.log(`[${relPath}]`, ...params);
			}
		};

		const { qualityLevels, breakpoints } = await Media.init(relPath);
		const pathHash = crypto.createHash('md5').update(toDiskPath(relPath)).digest('hex');
		const outDir = path.join(outputPath, pathHash);
		await fs.mkdirp(outDir);
		log(`Create output dir ${outDir}.`);

		const encodingDoneEmitter = new EventEmitter();

		let activeQualityLevel = null;
		let activeTranscoder = null;
		let playhead = -1;
		let encoderHead = -1;

		const getMasterManifest = () => [].concat.apply(
			['#EXTM3U'], 
			Array.from(qualityLevels.entries()).map(([levelName, { width, height, preset }]) => [
				`#EXT-X-STREAM-INF:BANDWIDTH=${preset.bandwidth},RESOLUTION=${width}x${height}`,
				`quality-${levelName}.m3u8`
			])
		).join(os.EOL);
		
		const getVariantManifest = qualityLevel => {
			const segments = new Array((breakpoints.length - 1) * 2);
			for (let i = 1; i < breakpoints.length; i++) {
				segments[i * 2 - 2] = '#EXTINF:' + (breakpoints[i] - breakpoints[i - 1]).toFixed(3);
				segments[i * 2 - 1] = `${qualityLevel}-${i.toString(16)}.ts`;
			}
            return [
                '#EXTM3U',
                '#EXT-X-PLAYLIST-TYPE:VOD',
                '#EXT-X-TARGETDURATION:4.75',
                '#EXT-X-VERSION:4',
                '#EXT-X-MEDIA-SEQUENCE:0', // I have no idea why this is needed.
                ...segments,
                '#EXT-X-ENDLIST'
            ].join(os.EOL);
		};

		const [startTranscode, restartIfNeeded] = [startAt => {
			assert.strictEqual(activeTranscoder, null, 'There is another transcoder being active.');

			assert((startAt >= 0) && (startAt < breakpoints.length - 1), "Starting point wrong.");

			const endAt = Math.min(breakpoints.length - 1, startAt + 512); // By default, encode the entire video. However, clamp if there are too many (> 512), just to prevent the command from going overwhelmingly long.

            const commaSeparatedTimes = breakpoints.subarray(startAt + 1, endAt).join(',');
            
            const transcoder = Run('ffmpeg', [
				'-loglevel', 'warning',
                '-ss', `${breakpoints[startAt]}`, // Seek to start point. 
                '-i', toDiskPath(relPath), // Input file
                '-to', `${breakpoints[endAt]}`,
				'-copyts', // So the "-to" refers to the original TS.
                '-force_key_frames', commaSeparatedTimes,
                '-vf', 'scale=' + ((activeQualityLevel.width >= activeQualityLevel.height) ? `-2:${activeQualityLevel.height}` : `${activeQualityLevel.width}:-2`), // Scaling
                '-preset', 'faster',
				'-sn', // No subtitles
                // Video params:
                '-c:v', 'libx264',
                '-profile:v', 'high',
                '-level:v', '4.0',
                '-b:v', `${activeQualityLevel.preset.videoBitrate}k`,
                // Audio params:
                '-c:a', 'aac',
                '-b:a', `${activeQualityLevel.preset.audioBitrate}k`,
                // Segmenting specs:
                '-f', 'segment',
                '-segment_time_delta', '0.2',
                '-segment_format', 'mpegts',
                '-segment_times', commaSeparatedTimes,
				'-segment_start_number', `${startAt}`,
				'-segment_list_type', 'flat',
				'-segment_list', 'pipe:1', // Output completed segments to stdout.
                `${activeQualityLevel.name}-%05d.ts`
			], { cwd: outDir });

			activeTranscoder = transcoder;
			encoderHead = startAt;

			const promise = transcoder.promise.then(code => {
				if ((code !== 0 /* Success */ || code !== 255 /* Terminated by us, likely */)) {
					// Likely an uncoverable error. No need to restart. Tell clients to fail.
					for (const name of encodingDoneEmitter.eventNames()) {
						encodingDoneEmitter.emit(name, `Ffmpeg exited w/ status code ${code}.`);
					}
				}
			}).finally(() => {
				assert.strictEqual(transcoder, activeTranscoder, 'Transcoder already detached.');
				activeTranscoder = null;
				encoderHead = -1;
			});

			readline.createInterface({
				input: transcoder.stdout,
			}).on('line', tsFileName => {
				if (!(tsFileName.startsWith(qualityLevel + '-') && tsFileName.endsWith('.ts'))) {
					throw new RangeError(`Cannot parse name ${tsFileName} from ffmpeg.`);
				}
				const index = parseInt(tsFileName.substring(qualityLevel.length + 1, tsFileName.length - 3), 10);
				level.segmentStatus[index] = Media.DONE;
				encodingDoneEmitter.emit(tsFileName, null);
				if (index >= endAt - 1) {
					// Nothing specifically need to be done here. Graceful shutdown will be done by transcoder.promise.then(...).
					if (endAt < breakpoints.length - 1) {
						// Whole video not finished yet.
						promise.then(() => restartIfNeeded('partially finished'));
					}
				} else {
					const bufferedLength = breakpoints[index + 1] - breakpoints[playhead];
					if (bufferedLength > videoMaxBufferLength) {
						// Terminate as we've buffered enough.
						log(`Terminating ffmpeg as we've buffered to ${index}(${breakpoints[index + 1]}), while the playhead is at ${playhead}(${breakpoints[playhead]})`);
						transcoder.kill();
					} else {
						// Keep it running.
						encoderHead = index + 1;
					}
				}
			});
        }, async reason => {
			if (activeTranscoder) {
				await activeTranscoder.kill();
			}
			// TODO(kmxz)
			log(`Starting ffmpeg (${reason}).`);
		}];

		const onGetSegment = async (qualityLevelObj, segmentIndex) => {
			this.playhead = segmentIndex;

			if (qualityLevelObj !== activeQualityLevel) {
				activeQualityLevel = qualityLevelObj;
				await restartIfNeeded('quality change');
				return; // restartIfNeeded will be called anyway. No need to continue in this method.
			}

			// Traverse through all the segments within mandatory buffer range.
			const startTime = breakpoints[segmentIndex];
			let shouldStartFromSegment = -1;
			for (let i = segmentIndex; (i < breakpoints.length - 1) && (breakpoints[i] - startTime < videoMinBufferLength); i++) {
				if (qualityLevelObj.segmentStatus[i] !== Media.DONE) {
					shouldStartFromSegment = i;
					break;
				}
			}
			if (shouldStartFromSegment >= 0) {
				if (activeTranscoder) {
					if (encoderHead < segmentIndex - 1) {
						await restartIfNeeded('fast forward');
					} else if (encoderHead > shouldStartFromSegment) {
						await restartIfNeeded('rewind');
					} else {
						// All good. We're soon to be there. Just be a bit patient...
						return;
					}
				} else {
					await restartIfNeeded('warm start');
				}
			}
			
		};
		
		const getSegment = (fileName, request, response) => {
			const [_, qualityLevelName, segmentNumber] = fileName.match(/^(.+)-([0-9a-f]+)\.ts$/);
			const level = qualityLevels.get(qualityLevelName);
			assert(level, `Quality level ${qualityLevelName} not exists.`);
			const segmentIndex = parseInt(segmentNumber, 16) - 1;
			assert((segmentIndex >= 0) && (segmentIndex < breakpoints.length - 1), `Segment index out of range.`);
			const fileName = `${qualityLevelName}-${((segmentIndex + 1e5) % 1e6).toString().substr(1)}.ts`;
			const filePath = path.join(outDir, fileName);

			const fileReady = level.segmentStatus[segmentIndex - 1] === Media.DONE;
			onGetSegment(level, segmentIndex);

			if (fileReady) {
				response.sendFile(filePath);
				return;
			} 
			const callback = errStr => {
				if (errStr) {
					response.status(500).send(errStr);
				} else {
					response.sendFile(filePath);
				}
			};
			encodingDoneEmitter.once(fileName, callback);
			request.on('close', () => encodingDoneEmitter.removeListener(fileName, callback));
		};
		
		const destruct = async () => {
			// Caller should ensure that the instance is already initialized.
			if (activeTranscoder) {
				await activeTranscoder.kill();
			}
			await fs.remove(outDir);
		};

		return { getMasterManifest, getVariantManifest, destruct };
	};

	Media.DONE = 2;

	Media.init = async relPath => {
		console.log(`Initializing video transcoder for ${relPath}...`);	
		const ffprobeOutput = JSON.parse(await Run('ffprobe', [
			'-v', 'error', // Hide debug information
			'-show_streams', // Show video dimensions
			'-skip_frame', 'nokey', '-show_entries', 'frame=pkt_pts_time', // List all I frames
			'-select_streams', 'v', // Video stream only, we're not interested in audio
			'-of', 'json' 
		], { timeout: ffprobeTimeout }).result());
		const { width, height, duration } = ffprobeOutput['streams'][0];
		
		const resolution = Math.min(width, height);
		const validIFrames = probeResult['frames'].map(frame => parseFloat(frame['pkt_pts_time'])).filter(time => !isNaN(time));
		const breakpoints = Media.convertToSegments(validIFrames, duration);

		return {
			qualityLevels: new Map(Object.entries(qualityLevelPresets).filter(([_, preset]) => preset.resolution <= resolution).map(([name, preset]) => 
				[name, {
					name,
					preset,
					width: Math.round(width / resolution * preset.resolution),
					height: Math.round(height / resolution * preset.resolution),
					segmentStatus: new Uint8Array(breakpoints.length - 1)
				}]
			)),
			breakpoints
		};
	};

	/**
	 * Calculate the timestamps to segment the video at. 
	 * Returns all segments endpoints, including video starting time (0) and end time.
	 * 
	 * - Use keyframes (i.e. I-frame) as much as possible.
	 * - For each key frame, if it's over 4.75 seconds since the last keyframe, insert a breakpoint between them in an evenly, such that the breakpoint distance is <= 3.5 seconds (per https://bitmovin.com/mpeg-dash-hls-segment-length/).
	 *   Example: key frame at 20.00 and 31.00, split at 22.75, 25.5, 28.25.
	 * - If the duration between two key frames is smaller than 2.25 seconds, ignore the existance of the second key frame.
	 * 
	 * This guarantees that all segments are between the duration 2.33 s and 4.75 s.
	 */
	Media.convertToSegments = (rawTimeList, duration) => {
		const timeList = rawTimeList.concat([duration]);
		const segmentStartTimes = [0];
		let lastTime = 0;
		for (const time of timeList) {
			if (time - lastTime < 2.25) {
				// Skip it regardless.
			} else if (time - lastTime < 4.75) {
				// Use it as-is.
				lastTime = time;
				segmentStartTimes.push(lastTime);
			} else {
				const numOfSegmentsNeeded = Math.ceil((time - lastTime) / 3.5);
				const durationOfEach = (time - lastTime) / numOfSegmentsNeeded;
				for (let i = 1; i < numOfSegmentsNeeded; i++) {
					lastTime += durationOfEach;
					segmentStartTimes.push(lastTime);
				}
				lastTime = time; // Use time directly instead of setting in the loop so we won't lose accuracy due to float point precision limit.
				segmentStartTimes.push(time);
			}
		}
		if (segmentStartTimes.length > 1) {
			segmentStartTimes.pop(); // Would be equal to duration unless the skip branch is executed for the last segment, which is fixed below.
			const lastSegmentLength = duration - segmentStartTimes[segmentStartTimes.length - 1];
			if (lastSegmentLength > 4.75) {
				segmentStartTimes.push(duration - lastSegmentLength / 2);
			}
		}
		segmentStartTimes.push(duration);
		return Float64Array.from(segmentStartTimes);
	};
    
    const MediaInfoCache = cacheSize => {
		const cache = new Map();
		
        const set = (relPath, info) => {
            if (cache.size >= cacheSize) { // Evict the first entry from the cache.
                const [keytoEvict, info] = cache.entries().next().value;
                info.then(result => result.destruct());
                cache.delete(keytoEvict);
            }
            cache.delete(relPath);
            cache.set(relPath, info);
		}
		
        const get = relPath => {
            let info = cache.get(relPath);
            if (!info) {
                info = new Media(relPath);
                set(relPath, info);
                info.catch(e => cache.delete(e));
            } else {
                cache.delete(relPath); // Remove it from the original position in the cache and let the "set()" below put it to the end. This is needed as we want the cache to be an LRU one.
            }
            cache.set(relPath, info);
            return info;
		}

		return get;
    }

    const cachedMedia = new MediaInfoCache(10);

    const browseDir = async browsePath => {
        const diskPath = toDiskPath(browsePath);

        const files = await fs.readdir(diskPath, { withFileTypes: true });
        const fileList = files.map(dirent => {
            const fileObj = {};
            fileObj.name = dirent.name;

            if (dirent.isFile()) {
                const relPath = path.join(browsePath, file);
                const extName = path.extname(file).toLowerCase();

                if (videoExtensions.includes(extName)) {
                    fileObj.type = 'video';
                } else if (audioExtensions.includes(extName)) {
                    fileObj.type = 'audio';
                }
                fileObj.relPath = path.join('/', relPath);
            } else if (dirent.isDirectory()) {
                fileObj.type = 'directory';
                fileObj.path = path.join(browsePath, file);
            }
        });
        return {
            cwd: browsePath,
            files: fileList
        };
    }

    // TODO: Legacy method. Will improve later.
    const handleThumbnailRequest = (file, response) => {
        const fsPath = toDiskPath(file);

        // http://superuser.com/questions/538112/meaningful-thumbnails-for-a-video-using-ffmpeg
        //var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=gt(scene\,0.4)', '-vf', 'scale=iw/2:-1,crop=iw:iw/2', '-f', 'image2pipe', '-vframes', '1', '-'];
        var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=eq(pict_type\\,PICT_TYPE_I),scale=640:-1,tile=2x2', '-f', 'image2pipe', '-vframes', '1', '-'];

        if (debug) console.log('Spawning thumb process');

        const encoderChild = Run('ffmpeg', args, {
            timeout: 15 * 1000
		});

		encoderChild.stdout.pipe(response);
		response.setHeader('Content-Type', 'image/jpeg');
        request.on('close', encoderChild.kill);
    }

    // TODO: Legacy method. Will improve later.
    // Problem: some clients interrupt the HTTP request and send a new one, causing the song to restart...
    function handleAudioRequest(relPath, request, response) {
        var filePath = toDiskPath(relPath);

        // TODO: Child management
        //var encoderChild = childProcess.spawn(transcoderPath, ['-i', filePath, '-b:a', 64 + 'k', '-ac', '2', '-acodec', 'libaacplus', '-threads', '0', '-f', 'adts', '-']);
        const encoderChild = Run('ffmpeg', [
            '-i', filePath, '-threads', '0',
            '-b:a', 192 + 'k', '-ac', '2', '-acodec', 'libmp3lame',
            '-map', '0:a:0',
            '-f', 'mp3', '-'
        ]);

		encoderChild.stdout.pipe(response);
        response.writeHead(200, {'Content-Type': 'audio/mpeg'});
        request.on('close', encoderChild.kill);
    }

    const handleVideoInitializationRequest = async filePath => {
        const probeResult = JSON.parse(await Run('ffprobe', [
            '-v', 'error', // Hide debug information
            '-show_format', // Show container information
            '-show_streams', // Show codec information
            toDiskPath(filePath)
        ], { timeout: ffprobeTimeout }).result());

        try {
            const format = probeResult['format']['format_name'].split(',')[0];
            const audioCodec = probeResult['streams'].find(stream => stream['codec_type'] === 'audio')['codec_name'];
            const videoCodec = probeResult['streams'].find(stream => stream['codec_type'] === 'video')['codec_name'];
            return {
                maybeNativelySupported: (nativeSupportedFormats.container.includes(format) && nativeSupportedFormats.audio.includes(audioCodec) && nativeSupportedFormats.video.includes(videoCodec))
            };
        } catch (e) {
            return {
                error: e.toString()
            };
        }
    };

    const handleMasterManifestRequest = async filePath => {
        return (await cachedMedia(filePath)).getMasterManifest();
    };

    const handleVariantManifestRequest = async (filePath, quality) => (await cachedMedia(filePath)).getVariantManifest(quality);

    const respond = (response, promise) =>
        promise.then(
            result => (((typeof result === 'string') || Buffer.isBuffer(result)) ? response.send : response.json)(result), 
            error => response.status(500).send(error.stack || error.toString())
		);

    const initExpress = () => {
        var app = express();
        var server = http.createServer(app);
        io = socketIo(server);

        app.use(bodyParser.urlencoded({extended: false}));

        app.use('/', serveStatic(path.join(__dirname, 'static')));

        app.get(/^\/video\//, (request, response) => {
            const relPath = path.relative('/video/', decodeURIComponent(request.path));
            handleVideoInitializationRequest(relPath, response);
        });

        // m3u8 file has to be under the same path as the TS-files, so they can be linked relatively in the m3u8 file
        app.get(/^\/hls\/(.+)\/master\.m3u8/, (request, response) => {
            const relPath = decodeURIComponent(request.params[0]);
            respond(response, handleMasterManifestRequest(relPath));
		});
		
        app.get(/^\/hls\/(.+)\/quality-(.+)\.m3u8/, (request, response) => {
            const relPath = decodeURIComponent(request.params[0]);
            const quality = request.params(1);
            respond(response, handleVariantManifestRequest(relPath, quality));
		});
	
        app.get(/^\/hls\/(.+)\/(quality)-(\d{5})\.m3u8/, (request, response) => {
            const relPath = decodeURIComponent(request.params[0]);
            const quality = request.params(1);
            respond(response, handleVariantManifestRequest(relPath, quality));
		});

        app.use('/hls/', serveStatic(outputPath));

        app.get(/^\/thumbnail\//, (request, response) => {
            const file = path.relative('/thumbnail/', decodeURIComponent(request.path));
            respond(response, handleThumbnailRequest(file, response));
        });

        app.get(/^\/browse/, (request, response) => {
            const browsePath = path.relative('/browse', decodeURIComponent(request.path));
            respond(response, browseDir(browsePath));
        });

        app.use('/raw/', serveStatic(rootPath));

        app.get(/^\/audio\//, function(request, response) {
            var relPath = path.relative('/audio/', decodeURIComponent(request.path));
            handleAudioRequest(relPath, request, response);
        });

        app.post(/^\/settings/, function(request, response) {
            console.log(request.body);

            var newBitrate = request.body.videoBitrate;
            if (newBitrate) {
                videoBitrate = parseInt(newBitrate);
            }

            response.end();
        });

        app.get(/^\/settings/, function(request, response) {
            response.setHeader('Content-Type', 'application/json');
            response.write(JSON.stringify({
                videoBitrate: videoBitrate
            }));
            response.end();
        });


        server.listen(listenPort);
        console.log('Listening to port', listenPort);
    }

    const init = () => {
        await fs.mkdirs(outputPath);

        console.log('Serving ' + rootPath);
        console.log('Created directory ' + outputPath);
        
        initExpress();
    }

    init();

	let termination = null;

    return () => {
		if (termination == null) {
			termination = Promise.all([
				Run.killAll(), // Kill all sub-processes.
				promisify(server.close).call(server), // Stop the server.
				fs.remove(outputPath) // Remove all cache files.
			]);
		}
		return termination;
	};
}

if (require.main === module) {
    const exitWithUsage = argv => {
        console.log(
            'Usage: ' + argv[0] + ' ' + argv[1]
            + ' --root-path PATH'
            + ' [--port PORT]'
            + ' [--cache-path PATH]'
			+ ' [--ffmpeg-binary-dir PATH]'
			+ ' [--buffer-length SECONDS]'
            + ' [--debug]'
        );
        process.exit();
    }

    const cleanup = main(parseArgs(process.argv.slice(2), {
        string: ['port', 'root-path', 'ffmpeg-binary-dir', 'cache-path', 'buffer-length'],
        boolean: 'debug',
        unknown: () => exitWithUsage(process.argv)
    }));

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

var playlistRetryDelay = 500;
var playlistRetryTimeout = 60000;
var playlistEndMinTime = 20000;
// Program state
var encoderProcesses = {};
var currentFile = null;
var lock = false;
var encodingStartTime = null;
var io = null;

// We have to apply some hacks to the playlist
function withModifiedPlaylist(readStream, eachLine, done) {
    var rl = readLine.createInterface({terminal: false, input: readStream});

    var foundPlaylistType = false;

    rl.on('line', function (line) {
        if (line.match('^#EXT-X-PLAYLIST-TYPE:')) foundPlaylistType = true;
        else if (line.match('^#EXTINF:') && !foundPlaylistType) {
            // Insert the type if it does not exist (ffmpeg doesn't seem to add this). Not having this set to VOD or EVENT will lead to no scrub-bar when encoding is completed
            eachLine('#EXT-X-PLAYLIST-TYPE:EVENT');
            foundPlaylistType = true;
        }

        // Due to what seems like a bug in Apples implementation, if #EXT-X-ENDLIST is included too fast, it seems the player will hang. Removing it will cause the player to re-fetch the playlist once more, which seems to prevent the bug.
        if (line.match('^#EXT-X-ENDLIST') && new Date().getTime() - encodingStartTime.getTime() < playlistEndMinTime) {
            console.log('File was encoded too fast, skiping END tag');
        }
        else {
            eachLine(line);
        }
    });
    rl.on('close', function() {
        if (debug) console.log('Done reading lines');
        done();
    });
}

function updateActiveTranscodings() {
    io.emit('updateActiveTranscodings', _.map(encoderProcesses, function(it) {
        return it.pid;
    }));
}

function spawnNewProcess(file, playlistPath) {
    var playlistFileName = 'stream.m3u8';

    console.log({ file });

    if (transcoderType === 'ffmpeg') {
        // https://www.ffmpeg.org/ffmpeg-formats.html#segment
        var tsOutputFormat = 'stream%05d.ts';
        var args = [
            '-i', file, '-sn',
            '-async', '1', '-acodec', 'libmp3lame', '-b:a', audioBitrate + 'k', '-ar', '44100', '-ac', '2',
            '-vf', 'scale=min(' + targetWidth + '\\, iw):-1', '-b:v', videoBitrate + 'k', '-vcodec', 'libx264', '-profile:v', 'baseline', '-preset:v' ,'superfast',
            '-x264opts', 'level=3.0',
            '-threads', '0', '-flags', '-global_header', '-map', '0',
            // '-map', '0:v:0', '-map', '0:a:1'
            '-f', 'segment',
            '-segment_list', playlistFileName, '-segment_format', 'mpegts', '-segment_list_flags', 'live', tsOutputFormat
            //'-segment_time', '10', '-force_key_frames', 'expr:gte(t,n_forced*10)',
            //'-f', 'hls', '-hls_time', '10', '-hls_list_size', '0', '-hls_allow_cache', '0', '-hls_segment_filename', tsOutputFormat, playlistFileName
        ];
    }
    else {
        // https://wiki.videolan.org/Documentation:Streaming_HowTo/Streaming_for_the_iPhone/
        var tsOutputFormat = 'stream#####.ts';

        var args = [
            '-I' ,'dummy', '--no-loop', '--no-repeat', file, 'vlc://quit',
            `--sout=#transcode{
                width=${targetWidth},fps=25,vcodec=h264,vb=${videoBitrate},
                venc=x264{aud,profile=baseline,level=30,keyint=30,ref=1,superfast},
                acodec=mp3,ab=${audioBitrate},channels=2,audio-sync
            }:std{
                access=livehttp{seglen=10,numsegs=0,index=${playlistFileName},index-url=${tsOutputFormat}},
                mux=ts{use-key-frames},dst=${tsOutputFormat}
            }`.replace(/\s/g, ''),
        ];
    }

    console.log('Exec:', transcoderPath, args.join(' '));
    var encoderChild = childProcess.spawn(transcoderPath, args, {cwd: outputPath, env: process.env});
    console.log('Spawned transcoder instance');

    encoderChild.on('error', err => console.error(err));

    if (debug) console.log(transcoderPath + ' ' + args.join(' '));

    encoderProcesses[file] = encoderChild;
    updateActiveTranscodings();
    currentFile = file;

    encoderChild.stderr.on('data', function(data) {
        if (debug) console.log(data.toString());
    });

    encoderChild.on('exit', function(code) {
        if (code == 0) {
            console.log('Transcoding completed');
        }
        else {
            console.log('Transcoder exited with code ' + code);
        }

        delete encoderProcesses[file];
        updateActiveTranscodings();
    });

    // Kill any "zombie" processes
    setTimeout(function() {
        if (encoderProcesses[file]) {
            console.log('Killing long running process');

            killProcess(encoderProcesses[file]);
        }
    }, processCleanupTimeout);
}

function pollForPlaylist(file, response, playlistPath) {
    var numTries = 0;

    function checkPlaylistCount(stream, cb) {
        var rl = readLine.createInterface({terminal: false, input: stream});
        var count = 0;
        var need = 3;
        var found = false;

        rl.on('line', function (line) {
            if (line.match('^#EXTINF:[0-9]+')) count++;
            if (count >= need) {
                found = true;
                // We should have closed here but it causes some issues on win10.
                // See https://github.com/mifi/hls-vod/pull/9
                // rl.close();
            }
        });
        rl.on('close', function() {
            if (debug) {
                if (!found) console.log('Found only ' + count + ' file(s) in playlist');
                else console.log('Found needed ' + need + ' files in playlist!');
            }

            cb(found);
        });
    }

    function retry() {
        numTries++;
        if (debug) console.log('Retrying playlist file...');
        setTimeout(tryOpenFile, playlistRetryDelay);
    }

    function tryOpenFile() {
        if (numTries > playlistRetryTimeout/playlistRetryDelay) {
            console.log('Whoops! Gave up trying to open m3u8 file');
            response.writeHead(500);
            response.end();
        }
        else {
            var readStream = fs.createReadStream(playlistPath);
            readStream.on('error', function(err) {
                if (err.code === 'ENOENT') {
                    if (debug) console.log('Playlist file does not exist.');
                    retry();
                }
                else console.log(err);
            });

            checkPlaylistCount(readStream, function(found) {
                if (!found) {
                    return retry();
                }

                if (debug) console.log('Found playlist file!');

                //response.sendfile(playlistPath);

                var readStream2 = fs.createReadStream(playlistPath);

                readStream2.on('error', function(err) {
                    console.log(err);
                    readStream2.close();
                    response.writeHead(500);
                    response.end();
                });

                response.setHeader('Content-Type', 'application/x-mpegURL');

                withModifiedPlaylist(readStream2, function(line) {
                    if (debug) console.log(line);
                    response.write(line + '\n');
                }, function() {
                    response.end();
                });
            });
        }
    }

    tryOpenFile();
}

function handlePlaylistRequest(file, response) {
    if (debug) console.log('Playlist request: ' + file)

    if (!file) {
        request.writeHead(400);
        request.end();
    }

    if (lock) {
        console.log('Ongoing spawn process not finished, denying request');
        response.writeHead(503);
        response.end();
        return;
    }

    file = path.join('/', file); // Remove ".." etc
    file = path.join(rootPath, file);
    var playlistPath = path.join(outputPath, '/stream.m3u8');

    if (currentFile != file) {
        lock = true;

        console.log('New file to encode chosen');

        encodingStartTime = new Date();

        function startNewEncoding() {
            fs.unlink(playlistPath, function (err) {
                spawnNewProcess(file, playlistPath, outputPath);
                pollForPlaylist(file, response, playlistPath);
                lock = false;
            });
        }

        // Make sure old one gets killed
        if (encoderProcesses[currentFile]) {
            killProcess(encoderProcesses[currentFile], startNewEncoding);
        }
        else {
            startNewEncoding();
        }
    }
    else {
        console.log('We are already encoding this file');
        pollForPlaylist(file, response, playlistPath);
    }
}
-
function init() {
    function exitWithUsage(argv) {
        console.log(
            'Usage: ' + argv[0] + ' ' + argv[1]
            + ' --root-path PATH'
            + ' [--port PORT]'
            + ' [--cache-path PATH]'
            + ' [--transcoder-path PATH]'
            + ' [--debug]'
        );
        process.exit();
    }

    for (var i=2; i<process.argv.length; i++) {
        switch (process.argv[i]) {
            case '--transcoder-path':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            transcoderPath = process.argv[++i];
            console.log('Transcoder path ' + transcoderPath);
            break;

            case '--root-path':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            rootPath = process.argv[++i];
            break;

            case '--search-path':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            searchPaths.push(process.argv[++i]);
            break;

            case '--cache-path':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            outputPath = process.argv[++i];
            break;

            case '--port':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            listenPort = parseInt(process.argv[++i]);
            break;

            case '--transcoder-type':
            if (process.argv.length <= i+1) {
                exitWithUsage(process.argv);
            }
            transcoderType = process.argv[++i];
            if (['vlc', 'ffmpeg'].indexOf(transcoderType) == -1) exitWithUsage(process.argv);
            break;

            case '--debug':
                debug = true;
            break;

            default:
            console.log(process.argv[i]);
            exitWithUsage(process.argv);
            break;
        }
    }

    if (!rootPath) rootPath = path.resolve('.');

    console.log('Serving', rootPath);

    if (!outputPath) outputPath = path.join(os.tmpdir(), 'hls-vod-cache');
    fs.mkdirsSync(outputPath);

    if (transcoderType === 'vlc') {
        const guessVlcPath = '/Applications/VLC.app/Contents/MacOS/VLC';
        if (fs.existsSync(guessVlcPath)) {
            transcoderPath = guessVlcPath;
        }
    }

    console.log('Created directory ' + outputPath);

    initExpress();
}

function initExpress() {
    var app = express();
    var server = http.Server(app);
    io = socketIo(server);

    app.use(bodyParser.urlencoded({extended: false}));

    app.all('*', function(request, response, next) {
        console.log(request.url);
        next();
    });

    app.use('/', serveStatic(path.join(__dirname, 'static')));

    // Flash plugin needs path to end with .m3u8, so we hack it with file name url encoded inside the path component!
    // In addition, m3u8 file has to be under the same path as the TS-files, so they can be linked relatively in the m3u8 file
    app.get(/^\/hls\/file-(.+)\.m3u8/, function(request, response) {
        var filePath = decodeURIComponent(request.params[0]);
        handlePlaylistRequest(filePath, response);
    });

    app.use('/hls/', serveStatic(outputPath));

    app.get(/^\/thumbnail\//, function(request, response) {
        var file = path.relative('/thumbnail/', decodeURIComponent(request.path));
        handleThumbnailRequest(file, response);
    });

    app.get(/^\/browse/, function(request, response) {
        var browsePath = path.relative('/browse', decodeURIComponent(request.path));
        browseDir(browsePath, response);
    });

    app.use('/raw/', serveStatic(rootPath));

    app.get(/^\/audio\//, function(request, response) {
        var relPath = path.relative('/audio/', decodeURIComponent(request.path));
        handleAudioRequest(relPath, request, response);
    });

    app.post(/^\/settings/, function(request, response) {
        console.log(request.body);

        var newBitrate = request.body.videoBitrate;
        if (newBitrate) {
            videoBitrate = parseInt(newBitrate);
        }

        response.end();
    });

    app.get(/^\/settings/, function(request, response) {
        response.setHeader('Content-Type', 'application/json');
        response.write(JSON.stringify({
            videoBitrate: videoBitrate
        }));
        response.end();
    });


    server.listen(listenPort);
    console.log('Listening to port', listenPort);
}


init();
