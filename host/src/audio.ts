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
  private master: GainNode | null = null;
  private quackBuf: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    this.bakeNoise(ctx);
    void this.loadSamples();
  }

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
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
      const ctx = this.ctx;
      if (!ctx) return;
      const quack = await this.fetchBuffer(ctx, "sfx/quack.mp3");
      if (quack) {
        this.quackBuf = quack;
        return;
      }
      // Letting the failed attempt stand would silence the quack for the rest of
      // the session over one bad fetch, so the next hit is free to try again.
      this.loading = null;
    })().catch(() => {
      this.loading = null;
    });
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

  private playBuffer(buf: AudioBuffer, gain = 1, at = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.out());
    src.start(ctx.currentTime + at);
  }

  private out(): AudioNode {
    this.ensure();
    return this.master ?? this.ctx!.destination;
  }

  private bakeNoise(ctx: AudioContext): void {
    if (this.noiseBuf) return;
    const duration = 0.12;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const env = 1 - i / frames;
      data[i] = (Math.random() * 2 - 1) * env * env;
    }
    this.noiseBuf = buffer;
  }

  private async whenRunning(): Promise<AudioContext | null> {
    const ctx = this.ensure();
    if (!ctx) return null;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        return null;
      }
    }
    return ctx.state === "running" ? ctx : null;
  }

  private noise(duration: number, gain: number, filterFreq = 2400): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = filterFreq;
    filter.Q.value = 0.8;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.out());
    src.start(t);
    src.stop(t + duration);
  }

  private tone(opts: Tone, at = 0): void {
    const ctx = this.ctx;
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
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.02, opts.dur));
    osc.connect(g);
    g.connect(this.out());
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.03);
  }

  private run(play: () => void): void {
    void this.whenRunning().then((ctx) => {
      if (ctx) play();
    });
  }

  hit(): void {
    this.duckHit();
  }

  /**
   * The impact stays synthesised and the quack is a recording layered over it.
   *
   * A real quack swells over a couple of hundred milliseconds, which is how ducks
   * sound but not how a hit should feel, so on its own it lands late and soft. The
   * blip gives the shot its instant bite and the recording gives it the bird. If
   * the sample has not loaded, or cannot be, the blip carries the sound alone.
   */
  duckHit(): void {
    this.run(() => {
      this.noise(0.06, 0.4, 2800);
      this.tone({ freq: 980, dur: 0.05, type: "square", gain: 0.32 });
      this.tone({ freq: 1480, dur: 0.08, type: "square", gain: 0.22 }, 0.045);
      this.tone({
        freq: 420,
        dur: 0.1,
        type: "square",
        gain: 0.18,
        slide: 1.7,
      }, 0.09);

      if (this.quackBuf) {
        this.playBuffer(this.quackBuf, 0.9, 0.03);
        return;
      }
      void this.loadSamples();
      this.tone({
        freq: 320,
        dur: 0.12,
        type: "square",
        gain: 0.15,
        slide: 0.6,
      }, 0.18);
      this.tone({
        freq: 820,
        dur: 0.75,
        type: "sawtooth",
        gain: 0.18,
        slide: 0.14,
      }, 0.12);
    });
  }

  fall(): void {
    this.run(() => {
      this.tone({
        freq: 760,
        dur: 0.7,
        type: "triangle",
        gain: 0.14,
        slide: 0.18,
      });
    });
  }

  laugh(): void {
    this.run(() => {
      const notes = [392, 330, 392, 330, 294, 262];
      notes.forEach((freq, i) => {
        this.tone({ freq, dur: 0.11, type: "square", gain: 0.16 }, i * 0.13);
      });
    });
  }

  got(): void {
    this.run(() => {
      this.tone({ freq: 440, dur: 0.08, type: "square", gain: 0.16 });
      this.tone({ freq: 554, dur: 0.08, type: "square", gain: 0.16 }, 0.09);
      this.tone({ freq: 659, dur: 0.18, type: "square", gain: 0.18 }, 0.18);
    });
  }
}

export const sfx = new Sfx();
