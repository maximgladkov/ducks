export type SampleName =
  | "title"
  | "start"
  | "dog"
  | "duck"
  | "got"
  | "clear"
  | "perfect"
  | "miss"
  | "gameover"
  | "fall"
  | "land"
  | "flap"
  | "gunshot"
  | "laugh"
  | "pause"
  | "count";

const SAMPLE_FILES: SampleName[] = [
  "title",
  "start",
  "dog",
  "duck",
  "got",
  "clear",
  "perfect",
  "miss",
  "gameover",
  "fall",
  "land",
  "flap",
  "gunshot",
  "laugh",
  "pause",
  "count",
];

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SampleName, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private bgm: { name: SampleName; src: AudioBufferSourceNode } | null = null;
  private loops = new Map<SampleName, AudioBufferSourceNode>();

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === "running";
  }

  async unlock(): Promise<boolean> {
    const ctx = this.ensure();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    void this.loadSamples();
    return ctx.state === "running";
  }

  play(name: SampleName, opts?: { gain?: number; at?: number }): void {
    this.run(() => {
      this.startBuffer(name, { gain: opts?.gain, at: opts?.at, loop: false });
    });
  }

  loop(name: SampleName): void {
    this.run(() => {
      if (this.bgm?.name === name) return;
      this.stopBgm();
      const src = this.startBuffer(name, { loop: true });
      if (src) this.bgm = { name, src };
    });
  }

  loopSfx(name: SampleName): void {
    this.run(() => {
      if (this.loops.has(name)) return;
      const src = this.startBuffer(name, { loop: true });
      if (src) this.loops.set(name, src);
    });
  }

  stop(name: SampleName): void {
    if (this.bgm?.name === name) this.stopBgm();
    const src = this.loops.get(name);
    if (!src) return;
    try {
      src.stop();
    } catch {}
    this.loops.delete(name);
  }

  stopBgm(): void {
    if (!this.bgm) return;
    try {
      this.bgm.src.stop();
    } catch {}
    this.bgm = null;
  }

  stopAll(): void {
    this.stopBgm();
    for (const src of this.loops.values()) {
      try {
        src.stop();
      } catch {}
    }
    this.loops.clear();
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
      const loaded = await Promise.all(
        SAMPLE_FILES.map(async (name) => {
          const buf = await this.fetchBuffer(ctx, `sfx/${name}.mp3`);
          return [name, buf] as const;
        }),
      );
      for (const [name, buf] of loaded) {
        if (buf) this.buffers.set(name, buf);
      }
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

  private startBuffer(
    name: SampleName,
    opts: { gain?: number; at?: number; loop: boolean },
  ): AudioBufferSourceNode | null {
    const ctx = this.ctx;
    const buf = this.buffers.get(name);
    if (!ctx || !buf) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = opts.loop;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    src.connect(g);
    g.connect(this.master ?? ctx.destination);
    src.onended = () => {
      if (this.bgm?.src === src) this.bgm = null;
      if (this.loops.get(name) === src) this.loops.delete(name);
    };
    src.start(ctx.currentTime + (opts.at ?? 0));
    return src;
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
    void this.loadSamples();
    return ctx.state === "running" ? ctx : null;
  }

  private run(play: () => void): void {
    void this.whenRunning().then((ctx) => {
      if (ctx) play();
    });
  }
}

export const sfx = new Sfx();
