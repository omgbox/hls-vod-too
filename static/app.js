class HlsVodToo extends Tonic {
    render () {
        const pathSectors = this.props.path.split('/').filter(_ => _);
        const type = pathSectors.shift();
        const legalPath = pathSectors.join('/');
        switch (type) {
            case 'video':
                return this.html`<div>Feature not implemented</div>`;
            case 'directory':
                return this.html`<hls-vod-browse path="${legalPath}"></hls-vod-browse>`;
            case 'audio':
                // TODO
            default:
                // TODO
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
}

class HlsVodBrowse extends Tonic {
    async * render() {
        yield this.html`<div class="alert alert-info">Loading directory ${this.props.path}...</div>`;
        let list;
        try {
            list = await (await fetch(`browse/${encodeURIComponent('/' + this.props.path)}`)).json();
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
                    ${list.map(file => this.html`<a class="list-group-item" href="${file.type ? `#/${file.type}/${encodeURI(pathPrefix + file.name)}` : '/raw/' + pathPrefix + file.name}">${file.name}</a>`)}
                </div>
            </main>
        `;
    }
}

Tonic.add(HlsVodBrowse);
Tonic.add(HlsVodToo);
