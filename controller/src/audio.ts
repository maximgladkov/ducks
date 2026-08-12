type Tone = {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  slide?: number;
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private shotBuf: AudioBuffer | null = null;
  private emptyBuf: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;

  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    this.bakeNoise(ctx);
    void this.loadSamples();
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AC();
      this.bakeNoise(this.ctx);
      void this.loadSamples();
    }
    return this.ctx;
  }

  private assetUrl(path: string): string {
    const base = import.meta.env.BASE_URL ?? "/";
    const root = base.endsWith("/") ? base : `${base}/`;
    return `${root}${path.replace(/^\//, "")}`;
  }

  private loadSamples(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const ctx = this.ensure();
      if (!ctx) return;
      const [shot, empty] = await Promise.all([
        this.fetchBuffer(ctx, "sfx/shotgun.mp3"),
        this.fetchBuffer(ctx, "sfx/empty.mp3"),
      ]);
      if (shot) this.shotBuf = shot;
      if (empty) this.emptyBuf = empty;
    })().catch(() => undefined);
    return this.loading;
  }

  private async fetchBuffer(
    ctx: AudioContext,
    path: string,
  ): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(this.assetUrl(path));
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      return await ctx.decodeAudioData(data.slice(0));
    } catch {
      return null;
    }
  }

  private bakeNoise(ctx: AudioContext): void {
    if (this.noiseBuf) return;
    const duration = 0.45;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuf = buffer;
  }

  private playBuffer(buf: AudioBuffer, gain = 1): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(ctx.destination);
    src.start();
  }

  private noiseBurst(
    duration: number,
    gain: number,
    opts: {
      type?: BiquadFilterType;
      freq?: number;
      q?: number;
      delay?: number;
    } = {},
  ): void {
    const ctx = this.ensure();
    if (!ctx || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? "bandpass";
    filter.frequency.value = opts.freq ?? 900;
    filter.Q.value = opts.q ?? 0.7;
    const g = ctx.createGain();
    const t = ctx.currentTime + (opts.delay ?? 0);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + duration);
  }

  private tone(opts: Tone, at = 0): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? "square";
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.slide) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(40, opts.freq * opts.slide),
        t0 + opts.dur,
      );
    }
    const peak = opts.gain ?? 0.12;
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  shot(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const play = () => {
      if (this.shotBuf) {
        this.playBuffer(this.shotBuf, 0.95);
        return;
      }
      this.shotSynth();
      void this.loadSamples();
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(play);
      return;
    }
    play();
  }

  empty(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const play = () => {
      if (this.emptyBuf) {
        this.playBuffer(this.emptyBuf, 0.85);
        return;
      }
      this.emptySynth();
      void this.loadSamples();
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(play);
      return;
    }
    play();
  }

  private shotSynth(): void {
    this.noiseBurst(0.05, 0.95, { type: "highpass", freq: 2200, q: 0.5 });
    this.noiseBurst(0.18, 0.7, { type: "bandpass", freq: 700, q: 0.55 });
    this.noiseBurst(0.32, 0.45, {
      type: "lowpass",
      freq: 380,
      q: 0.6,
      delay: 0.02,
    });
    this.tone({ freq: 95, dur: 0.12, type: "sine", gain: 0.7, slide: 0.35 });
    this.tone({
      freq: 160,
      dur: 0.09,
      type: "triangle",
      gain: 0.45,
      slide: 0.28,
    });
    this.tone(
      { freq: 55, dur: 0.22, type: "sine", gain: 0.55, slide: 0.45 },
      0.015,
    );
    this.noiseBurst(0.08, 0.22, {
      type: "highpass",
      freq: 3200,
      q: 1.2,
      delay: 0.14,
    });
  }

  private emptySynth(): void {
    this.tone({
      freq: 1800,
      dur: 0.035,
      type: "square",
      gain: 0.18,
      slide: 0.55,
    });
    this.tone(
      { freq: 420, dur: 0.05, type: "triangle", gain: 0.12, slide: 0.4 },
      0.01,
    );
    this.noiseBurst(0.04, 0.18, { type: "bandpass", freq: 2400, q: 1.4 });
  }
}

export const sfx = new Sfx();
