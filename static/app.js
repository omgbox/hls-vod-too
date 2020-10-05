const clientId = Math.random().toString(16).substr(2, 6) + '-' + (Date.now() % (2 ** 24)).toString(16);

Tonic.add(class HlsVodToo extends Tonic {
    render () {
        const pathSectors = this.props.path.split('/').filter(_ => _);
        const type = pathSectors.shift();
        const legalPath = pathSectors.join('/');
        switch (type) {
            case 'video':
                return this.html`<hls-vod-video path="${legalPath}"></hls-vod-video>`;
            case 'directory':
                return this.html`<hls-vod-browse path="${legalPath}"></hls-vod-browse>`;
            case 'audio':
                return this.html`<div class="alert alert-danger">Audio feature not implemented.</div>`;
            default:
        }
        window.location.hash = '#/directory/';
    }

    connected() {
        window.addEventListener('hashchange', this.hashChange);
    }

    disconnected() {
        window.removeEventListener('hashchange', this.hashChange);
    }

    constructor() {
        super();
        this.props.path = location.hash.substr(1);
        this.hashChange = () => {
            const path = location.hash.substr(1);
            if (path !== this.props.path) {
                this.reRender(() => ({ path }));
            }
        };
    }
});

Tonic.add(class HlsVodVideo extends Tonic {
    async * render() {
        yield this.html`<div class="alert alert-info">Loading metadata for ${this.props.path}...</div>`;
        let response;
        try {
            response = (await (await fetch(`/video/${encodeURIComponent('/' + this.props.path)}`)).json());
        } catch (e) {
            return this.html`<div class="alert alert-danger">Failed to load metadata: ${e}</div>`;
        }
        if (response.error) {
            return this.html`<div class="alert alert-warning">The file cannot be parsed as a video. You may want to <a href="${'/raw/' + encodeURI(this.props.path)}">download</a> it directly.</div>`;
        }
        return this.html`<hls-vod-video-impl path="${this.props.path}" native="${response.maybeNativelySupported}" buffer-length="${response.bufferLength}"></hls-vod-video-impl>`
    }
});

Tonic.add(class HlsVodBrowse extends Tonic {
    async * render() {
        yield this.html`<div class="alert alert-info">Loading directory ${this.props.path}...</div>`;
        let list;
        try {
            list = await (await fetch(`/browse/${encodeURIComponent('/' + this.props.path)}`)).json();
        } catch (e) {
            return this.html`<div class="alert alert-danger">Failed to load directory content: ${e}</div>`;
        }
        const sections = this.props.path.split('/');
        const pathPrefix = this.props.path ? (this.props.path + '/') : '';
        return this.html`
            <nav>
                <ol class="breadcrumb">
                    <li class="${'breadcrumb-item' + (this.props.path.length ? '' : ' active')}"><a href="#/directory/">Home</a></li>
                    ${sections.map((section, index) => 
                        this.html`<li class="${'breadcrumb-item' + ((index === sections.length - 1) ? ' active' : '')}"><a href="${'#/directory/' + encodeURI(sections.slice(0, index + 1).join('/'))}">${section}</a></li>`
                    )}
                </ol>
            </nav>
            <main>
                <div class="list-group">
                    ${list.map(file => this.html`<a class="list-group-item" href="${file.type ? `#/${file.type}/${encodeURI(pathPrefix + file.name)}` : '/raw/' + encodeURI(pathPrefix + file.name)}">${file.name}</a>`)}
                </div>
            </main>
        `;
    }
});

Tonic.add(class HlsVodVideoImpl extends Tonic {
    connected() { this.maybeReinit(); }

    updated() { this.maybeReinit(); }

    disconnected() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    maybeReinit() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        const element = this.querySelector('video.hls');
        const ctrl = this.querySelector('hls-vod-ctrl');
        if (!element) { return; }
        const hls = new Hls({
            maxLength: 10,
            maxMaxBufferLength: this.props.bufferLength
        });
        hls.loadSource(`/hls.${clientId}/${encodeURIComponent(this.props.path)}/master.m3u8`);
        hls.attachMedia(element);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            element.play();
            ctrl.reRender(props => ({
                ...props,
                levels: hls.levels.map(level => level.name),
                levelAuto: hls.autoLevelEnabled,
                level: hls.startLevel
            }));
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
            ctrl.reRender(props => ({
                ...props,
                levelAuto: hls.autoLevelEnabled,
                level: data.level,
                pending: false
            }));
        });
        hls.on(Hls.Events.ERROR, (_, data) => console.error(data));
        this.hls = hls;
    }
    
    render() {
        if (this.props.native) {
            return this.html`
                <div class="alert alert-info">
                    This browser is directly playing the video file. <a href="#" data-action="switch-to-hls">Switch to HLS</a> if the video cannot be played.
                </div>
                <div class="video-wrap">
                    <video controls src="${'/raw/' + encodeURI(this.props.path)}"></video>
                </div>
            `;
        } else {
            return this.html`
                <div class="video-wrap">
                    <video class="hls" controls></video>
                </div>
                <hls-vod-ctrl></hls-vod-ctrl>
            `;
        }
    }

    click(e) {
        const actionTarget = Tonic.match(e.target, '[data-action]');
        if (!actionTarget) { return; }
        e.preventDefault();
        if (actionTarget.dataset.action === 'switch-to-hls') {
            this.reRender(props => ({ ...props, native: false }));
        }
    }
});

Tonic.add(class HlsVodCtrl extends Tonic {
    render() {
        const levels = this.props.levels || [];
        const activeLevel = this.props.level; // might be undefined which is okay.
        const shown = !!this.props.shown;
        const disabled = !!this.props.pending;
        const auto = !!this.props.levelAuto;
        if (!shown) {
            return this.html`
                <form class="text-center"><a href="#" data-action="flip">Show control</a></form>
            `;
        } else {
            return this.html`
                <form class="text-center">
                    <a href="#" data-action="flip">Hide control</a><br />
                    <div class="btn-group btn-group-toggle">
                        ${levels.map((level, index) => {
                            const checked = (activeLevel === index) && !auto;
                            return this.html`
                                <label class="${'btn btn-secondary' + (checked ? ' active' : '') + (disabled ? ' disabled' : '')}">
                                    <input type="radio" name="quality" ...${{
                                        disabled,
                                        checked
                                    }} value="${String(index)}" />${level}
                                </label>
                            `;
                        })}
                        <label class="${'btn btn-secondary' + (auto ? ' active' : '') + (disabled ? ' disabled' : '')}">
                            <input type="radio" name="quality" ...${{
                                disabled,
                                checked: auto
                            }} value="-1" />Auto ${auto ? ' (' + levels[activeLevel] + ')' : ''}
                        </label>
                    </div>
                </form>
            `;
        }
    }
    click(e) {
        const actionTarget = Tonic.match(e.target, '[data-action]');
        if (!actionTarget) { return; }
        e.preventDefault();
        if (actionTarget.dataset.action === 'flip') {
            this.reRender(props => ({ ...props, shown: !props.shown }));
        }
    }

    input(e) {
        if (e.target.name !== 'quality') { return; }
        const level = parseInt(e.target.value);
        this.reRender((props) => ({ ...props, pending: true }));
        this.parentNode.hls.nextLevel = level;
    }
});