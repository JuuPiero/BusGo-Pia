import { AudioClip, AudioSource, field, GameObject, MonoBehaviour } from "@pia/core";

export class AudioManager extends MonoBehaviour {

    static instance: AudioManager;

    @field(GameObject)
    audioPrefab: GameObject | null = null;

    @field([AudioClip])
    audios: AudioClip[] = [];

    private audioDict: Map<string, AudioClip> = new Map();

    poolSize = 10;

    private pool: AudioSource[] = [];
    private musicSources: Map<string, AudioSource> = new Map();
    private musicSourceSet: Set<AudioSource> = new Set();

    public masterVolume = 1;
    public musicVolume = 1;
    public sfxVolume = 1;

    onLoad() {
        AudioManager.instance = this;

        for (let clip of this.audios) {
            this.audioDict.set(clip.name, clip);
        }

        this.initPool();
    }


    toggleVideo = () => {
        this.stopMusic()
    }


    // protected start(): void {
    // }

    initPool() {
        for (let i = 0; i < this.poolSize; i++) {
            this.createAudioSource();
        }
    }

    createAudioSource(): AudioSource {

        let node: GameObject;

        if (this.audioPrefab) {
            node = this.instantiate(this.audioPrefab);
        }
        else {
            node = new GameObject("AudioSource");
            node.addComponent(AudioSource);
        }

        node.transform.setParent(this.transform);

        const source = node.getComponent(AudioSource)!;
        // source.loop = false
        this.pool.push(source);

        return source;
    }

    getAvailable(): AudioSource {

        for (let s of this.pool) {
            if (!this.musicSourceSet.has(s) && !s.isPlaying) {
                return s;
            }
        }

        return this.createAudioSource();
    }

    private getMusicSource(name: string): AudioSource {
        let source = this.musicSources.get(name);
        if (!source) {
            source = this.createAudioSource();
            this.musicSources.set(name, source);
            this.musicSourceSet.add(source);
        }

        return source;
    }

    playOneShot(name: string, volume = 1, pitch = 1) {

        const clip = this.audioDict.get(name);
        if (!clip) {
            console.warn("Audio not found:", name);
            return;
        }

        const source = this.getAvailable();

        // source.pitch = pitch;
        source.volume = this.masterVolume * this.sfxVolume * volume;
        source.playOneShot(clip);
    }

    playMusic(name: string, loop = true) {

        const clip = this.audioDict.get(name);
        if (!clip) return;

        const source = this.getMusicSource(name);

        source.clip = clip;
        source.loop = loop;
        source.volume = this.masterVolume * this.musicVolume;

        if (!source.isPlaying) {
            source.play();
        }
    }

    playMusicFade(name: string, duration = 1) {

        const clip = this.audioDict.get(name);
        if (!clip) return;

        const source = this.getMusicSource(name);

        source.clip = clip;
        source.loop = true;
        source.volume = 0;

        source.play();

        // tween(source)
        //     .to(duration, { volume: this.masterVolume * this.musicVolume })
        //     .start();
    }

    stopMusic() {

        for (let s of this.musicSources.values()) {
            if (s.isPlaying) {
                s.stop();
            }
        }
    }

    stopMusicFade(duration = 1) {

        for (let s of this.musicSources.values()) {

            if (s.isPlaying) {
                
                // tween(s)
                //     .to(duration, { volume: 0 })
                //     .call(() => s.stop())
                //     .start();
            }
        }
    }

    stopAll() {
        for (let s of this.pool) {
            s.stop();
        }
    }

    pauseAll() {
        for (let s of this.pool) {
            s.pause();
        }
    }

    resumeAll() {
        for (let s of this.pool) {
            s.play();
        }
    }

    setMasterVolume(v: number) {
        this.masterVolume = Math.max(0, Math.min(1, v));
        this.updateVolumes();
    }

    setMusicVolume(v: number) {
        this.musicVolume = Math.max(0, Math.min(1, v));
        this.updateVolumes();
    }

    setSFXVolume(v: number) {
        this.sfxVolume = Math.max(0, Math.min(1, v));
    }

    updateVolumes() {

        for (let s of this.pool) {

            if (s.loop) {
                s.volume = this.masterVolume * this.musicVolume;
            }
        }
    }

    has(name: string) {
        return this.audioDict.has(name);
    }

}
