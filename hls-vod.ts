#!/usr/bin/env ts-node

import assert = require('assert');
import childProcess = require('child_process');
import http = require('http');
import path = require('path');
import os = require('os');
import readline = require('readline');
import crypto = require('crypto');
import fs = require('fs/promises');
import events = require('events');
import util = require('util');

// 3rd party
import fsExtra = require('fs-extra');
import express = require('express');
import serveStatic = require('serve-static');
import parseArgs = require('minimist');
import socketIo = require('socket.io');

if (typeof require('fs').Dirent !== 'function') {
    throw new Error(`The Node.js version is too old for ${__filename} to run.`);
}

const videoExtensions = ['.mp4', '.3gp2', '.3gp', '.3gpp', '.3gp2', '.amv', '.asf', '.avs', '.dat', '.dv', '.dvr-ms', '.f4v', '.m1v', '.m2p', '.m2ts', '.m2v', '.m4v', '.mkv', '.mod', '.mp4', '.mpe', '.mpeg1', '.mpeg2', '.divx', '.mpeg4', '.mpv', '.mts', '.mxf', '.nsv', '.ogg', '.ogm', '.mov', '.qt', '.rv', '.tod', '.trp', '.tp', '.vob', '.vro', '.wmv', '.web,', '.rmvb', '.rm', '.ogv', '.mpg', '.avi', '.mkv', '.wmv', '.asf', '.m4v', '.flv', '.mpg', '.mpeg', '.mov', '.vob', '.ts', '.webm'];
const audioExtensions = ['.mp3', '.aac', '.m4a'];

type QualityLevelPreset = { resolution: number; videoBitrate: number; audioBitrate: number;  };
const qualityLevelPresets: Record<string, QualityLevelPreset> = {
    '1080p-extra': { resolution: 1080, videoBitrate: 14400, audioBitrate: 320 },
    '1080p': { resolution: 1080, videoBitrate: 9600,  audioBitrate: 224 },
    '720p': { resolution: 720, videoBitrate: 4800,  audioBitrate: 160 },
    '480p': { resolution: 480, videoBitrate: 2400,  audioBitrate: 128 },
    '360p': { resolution: 360, videoBitrate: 1200,  audioBitrate: 112 }
};

const ffprobeTimeout = 30 * 1000; // millisecs.
const processCleanupTimeout = 6 * 60 * 60 * 1000; // millisecs.

// Those formats can be supported by the browser natively: transcoding may not be needed for them.
// Listed in https://www.chromium.org/audio-video; change accordingly if you are mainly targeting another browser.
const nativeSupportedFormats = {
    container: ['mov', 'mp4', 'webm', 'ogg'],
    video: ['h264','vp8', 'vp9',' theora'],
    audio: ['aac', 'mp3', 'vorbis', 'opus', 'pcm_u8', 'pcm_s16le', 'pcm_f32le', 'flac']
};

type QualityLevel = {
    name: string;
    preset: QualityLevelPreset;
    width: number;
    height: number;
    segmentStatus: Uint8Array;
};

class Media {
    private static readonly DONE: number = 2;

    private readonly qualityLevels: Map<string, QualityLevel>;
    private readonly breakpoints: Float64Array;
    private readonly encodingDoneEmitter: events.EventEmitter = new events.EventEmitter();

    private activeQualityLevel: QualityLevel | null = null;
    private activeTranscoder: SubProcessInvocation | null = null;
    private playhead: number = -1;
    private encoderHead: number = -1;

    private constructor(
        readonly parent: HlsVod, 
        readonly relPath: string,
        readonly outDir: string,
        readonly ffProbeResult: string
    ) { 
        const ffprobeOutput = JSON.parse(ffProbeResult);
		const { width, height, duration } = ffprobeOutput['streams'][0];
		
		const resolution = Math.min(width, height);
        const validIFrames = ffprobeOutput['frames'].map((frame: Record<string, string>) => parseFloat(frame['pkt_pts_time'])).filter(time => !isNaN(time));
        
		this.breakpoints = Media.convertToSegments(validIFrames, duration);
		
        this.qualityLevels = new Map(Object.entries(qualityLevelPresets).filter(([_, preset]) => preset.resolution <= resolution).map(([name, preset]) => 
            [name, {
                name,
                preset,
                width: Math.round(width / resolution * preset.resolution),
                height: Math.round(height / resolution * preset.resolution),
                segmentStatus: new Uint8Array(this.breakpoints.length - 1)
            }]
        )); 

        this.log(`Video transcoder initialized. Using output directory ${outDir}.`);
    }

    public static async getInstance(
        parent: HlsVod, 
        relPath: string
    ): Promise<Media> {
        const ffprobeOutput = await (new parent.SubProcessInvocation('ffprobe', [
			'-v', 'error', // Hide debug information
			'-show_streams', // Show video dimensions
			'-skip_frame', 'nokey', '-show_entries', 'frame=pkt_pts_time', // List all I frames
			'-select_streams', 'v', // Video stream only, we're not interested in audio
            '-of', 'json',
            parent.toDiskPath(relPath)
        ], { timeout: ffprobeTimeout })).result();
        
		const pathHash = crypto.createHash('md5').update(parent.toDiskPath(relPath)).digest('hex');
        const outDir = path.join(parent.outputPath, pathHash);
        await fsExtra.mkdirp(outDir);

        return new Media(parent, relPath, outDir, ffprobeOutput);
    }

    getMasterManifest(): string {
        return ['#EXTM3U'].concat(
            ...Array.from(this.qualityLevels.entries()).map(([levelName, { width, height, preset }]) => [
                `#EXT-X-STREAM-INF:BANDWIDTH=${
                    (preset.videoBitrate + preset.audioBitrate) * 1.05 // 5% estimated container overhead.
                },RESOLUTION=${width}x${height}`,
                `quality-${levelName}.m3u8`
            ])
        ).join(os.EOL)
    };
    
    getVariantManifest(qualityLevelName: string): string {
        const segments = new Array((this.breakpoints.length - 1) * 2);
        for (let i = 1; i < this.breakpoints.length; i++) {
            segments[i * 2 - 2] = '#EXTINF:' + (this.breakpoints[i] - this.breakpoints[i - 1]).toFixed(3);
            segments[i * 2 - 1] = `${qualityLevelName}-${i.toString(16)}.ts`;
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

    private startTranscode(startAt: number): void {
        assert.strictEqual(this.activeTranscoder, null, 'There is another transcoder being active.');
        const level = this.activeQualityLevel;
        assert(level && (startAt >= 0) && (startAt < this.breakpoints.length - 1), "Starting point wrong.");

        const endAt = Math.min(this.breakpoints.length - 1, startAt + 512); // By default, encode the entire video. However, clamp if there are too many (> 512), just to prevent the command from going overwhelmingly long.

        const commaSeparatedTimes = this.breakpoints.subarray(startAt + 1, endAt).join(',');

        const transcoder = new this.parent.SubProcessInvocation('ffmpeg', [
            '-loglevel', 'warning',
            '-ss', `${this.breakpoints[startAt]}`, // Seek to start point. 
            '-i', this.parent.toDiskPath(this.relPath), // Input file
            '-to', `${this.breakpoints[endAt]}`,
            '-copyts', // So the "-to" refers to the original TS.
            '-force_key_frames', commaSeparatedTimes,
            '-vf', 'scale=' + ((level.width >= level.height) ? `-2:${level.height}` : `${level.width}:-2`), // Scaling
            '-preset', 'faster',
            '-sn', // No subtitles
            // Video params:
            '-c:v', 'libx264',
            '-profile:v', 'high',
            '-level:v', '4.0',
            '-b:v', `${level.preset.videoBitrate}k`,
            // Audio params:
            '-c:a', 'aac',
            '-b:a', `${level.preset.audioBitrate}k`,
            // Segmenting specs:
            '-f', 'segment',
            '-segment_time_delta', '0.2',
            '-segment_format', 'mpegts',
            '-segment_times', commaSeparatedTimes,
            '-segment_start_number', `${startAt}`,
            '-segment_list_type', 'flat',
            '-segment_list', 'pipe:1', // Output completed segments to stdout.
            `${level.name}-%05d.ts`
        ], { cwd: this.outDir });

        this.activeTranscoder = transcoder;
        this.encoderHead = startAt;

        const promise = transcoder.promise.then(code => {
            if ((code !== 0 /* Success */ && code !== 255 /* Terminated by us, likely */)) {
                // Likely an uncoverable error. No need to restart. Tell clients to fail.
                for (const name of this.encodingDoneEmitter.eventNames()) {
                    this.encodingDoneEmitter.emit(name, `Ffmpeg exited w/ status code ${code}.`);
                }
            }
        }).finally(() => {
            assert.strictEqual(transcoder, this.activeTranscoder, 'Transcoder already detached.');
            this.activeTranscoder = null;
            this.encoderHead = -1;
        });

        readline.createInterface({
            input: transcoder.stdout,
        }).on('line', tsFileName => {
            if (!(tsFileName.startsWith(level.name + '-') && tsFileName.endsWith('.ts'))) {
                throw new RangeError(`Cannot parse name ${tsFileName} from ffmpeg.`);
            }
            const index = parseInt(tsFileName.substring(level.name.length + 1, tsFileName.length - 3), 10);
            level.segmentStatus[index] = Media.DONE;
            this.encodingDoneEmitter.emit(tsFileName, null);
            if (index >= endAt - 1) {
                // Nothing specifically need to be done here. Graceful shutdown will be done by transcoder.promise.then(...).
                if (endAt < this.breakpoints.length - 1) {
                    // Whole video not finished yet.
                    promise.then(() => this.restartIfNeeded('partially finished'));
                }
            } else {
                const bufferedLength = this.breakpoints[index + 1] - this.breakpoints[this.playhead];
                if (bufferedLength > this.parent.videoMaxBufferLength) {
                    // Terminate as we've buffered enough.
                    this.log(`Terminating ffmpeg as we've buffered to ${index}(${this.breakpoints[index + 1]}), while the playhead is at ${this.playhead}(${this.breakpoints[this.playhead]})`);
                    transcoder.kill();
                } else {
                    // Keep it running.
                    this.encoderHead = index + 1;
                }
            }
        });
    }

    private async restartIfNeeded(reason: string): Promise<void> {
        if (this.activeTranscoder) {
            await this.activeTranscoder.kill();
        }
        // TODO(kmxz)
        this.log(`Starting ffmpeg (${reason}).`);
    }

    private async onGetSegment(qualityLevelObj: QualityLevel, segmentIndex: number) {
        this.playhead = segmentIndex;

        if (qualityLevelObj !== this.activeQualityLevel) {
            this.activeQualityLevel = qualityLevelObj;
            await this.restartIfNeeded('quality change');
            return; // restartIfNeeded will be called anyway. No need to continue in this method.
        }

        // Traverse through all the segments within mandatory buffer range.
        const startTime = this.breakpoints[segmentIndex];
        let shouldStartFromSegment = -1;
        for (let i = segmentIndex; (i < this.breakpoints.length - 1) && (this.breakpoints[i] - startTime < this.parent.videoMinBufferLength); i++) {
            if (qualityLevelObj.segmentStatus[i] !== Media.DONE) {
                shouldStartFromSegment = i;
                break;
            }
        }
        if (shouldStartFromSegment >= 0) {
            if (this.activeTranscoder) {
                if (this.encoderHead < segmentIndex - 1) {
                    await this.restartIfNeeded('fast forward');
                } else if (this.encoderHead > shouldStartFromSegment) {
                    await this.restartIfNeeded('rewind');
                } else {
                    // All good. We're soon to be there. Just be a bit patient...
                    return;
                }
            } else {
                await this.restartIfNeeded('warm start');
            }
        }
    };

    getSegment(httpPath: string, request: express.Request, response: express.Response): void {
        const [_, qualityLevelName, segmentNumber] = httpPath.match(/^(.+)-([0-9a-f]+)$/)!;
        const level = this.qualityLevels.get(qualityLevelName);
        assert(level, `Quality level ${qualityLevelName} not exists.`);
        const segmentIndex = parseInt(segmentNumber, 16) - 1;
        assert((segmentIndex >= 0) && (segmentIndex < this.breakpoints.length - 1), `Segment index out of range.`);
        const fileName = `${qualityLevelName}-${((segmentIndex + 1e5) % 1e6).toString().substr(1)}.ts`;
        const filePath = path.join(this.outDir, fileName);

        const fileReady = level.segmentStatus[segmentIndex - 1] === Media.DONE;
        this.onGetSegment(level, segmentIndex);

        if (fileReady) {
            response.sendFile(filePath);
            return;
        } 
        const callback = (errStr: string) => {
            if (errStr) {
                response.status(500).send(errStr);
            } else {
                response.sendFile(filePath);
            }
        };
        this.encodingDoneEmitter.once(fileName, callback);
        request.on('close', () => this.encodingDoneEmitter.removeListener(fileName, callback));
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
	private static convertToSegments(rawTimeList: number[], duration: number): Float64Array {
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

    async destruct() {
        // Caller should ensure that the instance is already initialized.
        if (this.activeTranscoder) {
            await this.activeTranscoder.kill();
        }
        await fsExtra.remove(this.outDir);
    };
    
    private log(...params: any): void {
        if (this.parent.debug) {
            console.log(`[${this.relPath}]`, ...params);
        }
    };
}

class MediaInfoCache {
    private readonly cache: Map<String, Promise<Media>> = new Map();

    constructor(private readonly parent: HlsVod, private readonly cacheSize: number) {}
    
    private async set(relPath: string, info: Promise<Media>): Promise<void> {
        if (this.cache.size >= this.cacheSize) { // Evict the first entry from the cache.
            const [keytoEvict, info] = this.cache.entries().next().value;
            await (await info).destruct();
            this.cache.delete(keytoEvict);
        }
        this.cache.delete(relPath);
        this.cache.set(relPath, info);
    }
    
    async get(relPath: string): Promise<Media> {
        let info = this.cache.get(relPath);
        if (!info) {
            info = Media.getInstance(this.parent, relPath);
            await this.set(relPath, info);
            info.catch(e => this.cache.delete(e));
        } else {
            this.cache.delete(relPath); // Remove it from the original position in the cache and let the "set()" below put it to the end. This is needed as we want the cache to be an LRU one.
        }
        this.cache.set(relPath, info);
        return await info;
    }
}

type FileEntry = { type: 'video' | 'audio' | 'directory'; name: string; };

/**
 * Main entry point for a program instance. You can run multiple instances as long as they use different ports and output paths.
 * 
 * Returns an async function to clean up.
 */
class HlsVod {

    public readonly SubProcessInvocation = class SubProcessInvocation {
        static parent: HlsVod;
        private static readonly allSubProcesses: Set<childProcess.ChildProcess> = new Set();

        public readonly promise: Promise<number>;
        public readonly stdout: NonNullable<childProcess.ChildProcess['stdout']>;
        private readonly process: childProcess.ChildProcess;

        constructor(
            command: string, 
            args: string[],
            { timeout, cwd } : { timeout?: number, cwd?: string } = {}
        ) {
            const processHandle = childProcess.spawn(
                SubProcessInvocation.parent.ffmpegBinaryDir + command,
                args,
                { cwd: cwd || SubProcessInvocation.parent.outputPath, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] }
            );
            SubProcessInvocation.allSubProcesses.add(processHandle);
            process.on('exit', () => SubProcessInvocation.allSubProcesses.delete(processHandle));
            this.process = processHandle;
            this.stdout = processHandle.stdout;

            this.promise = new Promise((res, rej) => {
                let timeoutRef: ReturnType<typeof setTimeout>;
                const onFinish = (code: number) => {
                    clearTimeout(timeoutRef);
                    res(code);
                };
                processHandle.on('exit', onFinish);
                timeoutRef = setTimeout(async () => {
                    processHandle.removeListener('exit', onFinish);
                    await SubProcessInvocation.killProcess(processHandle);
                    rej(new Error('Child process timeout.'));
                }, timeout || processCleanupTimeout);
            });
        }

        public async result(): Promise<string> {
            let stdoutBuf = '';
            this.stdout.on('data', data => { 
                stdoutBuf += data;
            });
            const code = await this.promise;
            if (code != 0) { throw new Error(`Process ${this.process.pid} exited w/ status ${code}.`); }
            return stdoutBuf;
        };

        public kill(): Promise<number> { return SubProcessInvocation.killProcess(this.process); }

        public static killAll(): Promise<unknown> { return Promise.all(Array.from(SubProcessInvocation.allSubProcesses).map(SubProcessInvocation.killProcess)); }

        private static killProcess(processToKill: childProcess.ChildProcess): Promise<number> {
            return new Promise(res => {
                processToKill.on('exit', res);
                processToKill.kill();
                setTimeout(() => processToKill.kill('SIGKILL'), 5000);
            });
        }
    }

    readonly ffmpegBinaryDir: string;
    readonly outputPath: string;
    readonly debug: boolean;
    readonly videoMinBufferLength: number;
    readonly videoMaxBufferLength: number;
    readonly server: http.Server = this.initExpress();

    private readonly listenPort: number;
    private readonly rootPath: string;
    private readonly cachedMedia = new MediaInfoCache(this, 10);

    constructor(params: { [s: string]: any; }) {
        this.SubProcessInvocation.parent = this;

        this.listenPort = parseInt(params['port']) || 4040;
        this.rootPath = path.resolve(params['root-path'] || '.');
        this.ffmpegBinaryDir = params['ffmpeg-binary-dir'] ? (params['ffmpeg-binary-dir'] + path.sep) : '';
        this.outputPath = path.resolve(params['cache-path'] || path.join(os.tmpdir(), 'hls-vod-cache'));
        this.debug = params['debug'];
        this.videoMinBufferLength = parseInt(params['buffer-length']) || 30;
        this.videoMaxBufferLength = this.videoMinBufferLength * 2;
    }

    public toDiskPath(relPath: string): string {
        return path.join(this.rootPath, path.join('/', relPath));
    }
    
    private async browseDir(browsePath: string): Promise<FileEntry[]> {
        const diskPath = this.toDiskPath(browsePath);

        const files = await fs.readdir(diskPath, { withFileTypes: true });
        const fileList = files.map(dirent => {
            const fileObj: Partial<FileEntry> = {};
            fileObj.name = dirent.name;
            if (dirent.isFile()) {
                const extName = path.extname(dirent.name).toLowerCase();
                if (videoExtensions.includes(extName)) {
                    fileObj.type = 'video';
                } else if (audioExtensions.includes(extName)) {
                    fileObj.type = 'audio';
                }
            } else if (dirent.isDirectory()) {
                fileObj.type = 'directory';
            }
            return fileObj as FileEntry;
        });
        return fileList;
    }

    // TODO: Legacy method. Will improve later.
    private handleThumbnailRequest(file: string, request: express.Request, response: express.Response): void {
        const fsPath = this.toDiskPath(file);

        // http://superuser.com/questions/538112/meaningful-thumbnails-for-a-video-using-ffmpeg
        //var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=gt(scene\,0.4)', '-vf', 'scale=iw/2:-1,crop=iw:iw/2', '-f', 'image2pipe', '-vframes', '1', '-'];
        var args = ['-ss', '00:00:20', '-i', fsPath, '-vf', 'select=eq(pict_type\\,PICT_TYPE_I),scale=640:-1,tile=2x2', '-f', 'image2pipe', '-vframes', '1', '-'];

        if (this.debug) console.log('Spawning thumb process');

        const encoderChild = new this.SubProcessInvocation('ffmpeg', args, {
            timeout: 15 * 1000
		});

		encoderChild.stdout.pipe(response);
		response.setHeader('Content-Type', 'image/jpeg');
        request.on('close', encoderChild.kill);
    }

    // TODO: Legacy method. Will improve later.
    // Problem: some clients interrupt the HTTP request and send a new one, causing the song to restart...
    private handleAudioRequest(relPath: string, request: express.Request, response: express.Response): void {
        var filePath = this.toDiskPath(relPath);

        // TODO: Child management
        //var encoderChild = childProcess.spawn(transcoderPath, ['-i', filePath, '-b:a', 64 + 'k', '-ac', '2', '-acodec', 'libaacplus', '-threads', '0', '-f', 'adts', '-']);
        const encoderChild = new this.SubProcessInvocation('ffmpeg', [
            '-i', filePath, '-threads', '0',
            '-b:a', 192 + 'k', '-ac', '2', '-acodec', 'libmp3lame',
            '-map', '0:a:0',
            '-f', 'mp3', '-'
        ]);

		encoderChild.stdout.pipe(response);
        response.writeHead(200, {'Content-Type': 'audio/mpeg'});
        request.on('close', encoderChild.kill);
    }

    private async handleVideoInitializationRequest(filePath: string): Promise<{ error: string } | { maybeNativelySupported: boolean }> {
        const probeResult = JSON.parse(await (new this.SubProcessInvocation('ffprobe', [
            '-v', 'error', // Hide debug information
            '-show_format', // Show container information
            '-show_streams', // Show codec information
            this.toDiskPath(filePath)
        ], { timeout: ffprobeTimeout })).result());

        try {
            const format = probeResult['format']['format_name'].split(',')[0];
            const audioCodec = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'audio')['codec_name'];
            const videoCodec = probeResult['streams'].find((stream: Record<string, string>) => stream['codec_type'] === 'video')['codec_name'];
            return {
                maybeNativelySupported: (nativeSupportedFormats.container.includes(format) && nativeSupportedFormats.audio.includes(audioCodec) && nativeSupportedFormats.video.includes(videoCodec))
            };
        } catch (e) {
            return {
                error: e.toString()
            };
        }
    };

    private initExpress(): http.Server {
        const defaultCatch = (response: express.Response) => (error: Error) => response.status(500).send(error.stack || error.toString());

        const respond = (response: express.Response, promise: Promise<string | Buffer | Object>): Promise<unknown> => promise.then(result => (((typeof result === 'string') || Buffer.isBuffer(result)) ? response.send : response.json)(result)).catch(defaultCatch(response));
        
        const app = express();
        const server = http.createServer(app);
        const io = socketIo(server);

        app.use('/', serveStatic(path.join(__dirname, 'static')));

        app.get('/video/:file', (request, response) => {
            respond(response, this.handleVideoInitializationRequest(request.params['file']));
        });

        // m3u8 file has to be under the same path as the TS-files, so they can be linked relatively in the m3u8 file
        app.get('/hls/:file/master.m3u8', (request, response) => {
            respond(response, this.cachedMedia.get(request.params['file']).then(media => media.getMasterManifest()));
		});
		
        app.get('/hls/:file/quality-:quality.m3u8', (request, response) => {
            respond(response, this.cachedMedia.get(request.params['file']).then(media => media.getVariantManifest(request.params['quality'])));
		});

        app.get('/hls/:file/:segment.ts', (request, response) => {
            this.cachedMedia.get(request.params['file']).then(media => 
                media.getSegment(request.params['segment'], request, response)
            ).catch(defaultCatch);
		});

        app.get('/thumbnail/:file', (request, response) => {
            this.handleThumbnailRequest(request.params['file'], request, response);
        });

        app.get('/browse/:file', (request, response) => {
            respond(response, this.browseDir(request.params['file']));
        });

        app.use('/raw/', serveStatic(this.rootPath));

        app.get('/audio/:file', (request, response) => {
            this.handleAudioRequest(request.params['file'], request, response);
        });

        return server;
    }

    async init(): Promise<void> {
        await fsExtra.mkdirs(this.outputPath);

        console.log('Serving ' + this.rootPath);
        console.log('Created directory ' + this.outputPath);

        this.server.listen(this.listenPort);
        console.log('Listening to port', this.listenPort);
    }

    private termination: Promise<unknown> | null = null;

    async cleanup() {
        if (this.termination == null) {
			this.termination = Promise.all([
				this.SubProcessInvocation.killAll(), // Kill all sub-processes.
				util.promisify(this.server.close).call(this.server), // Stop the server.
				fsExtra.remove(this.outputPath) // Remove all cache files.
			]);
		}
		return this.termination;
    }
}

if (require.main === module) {
    const exitWithUsage = (argv: string[]) => {
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

    const server = new HlsVod(parseArgs(process.argv.slice(2), {
        string: ['port', 'root-path', 'ffmpeg-binary-dir', 'cache-path', 'buffer-length'],
        boolean: 'debug',
        unknown: () => exitWithUsage(process.argv)
    }));

    server.init();

    process.on('SIGINT', () => server.cleanup());
    process.on('SIGTERM', () => server.cleanup());
}