export class Sfx {
  private ctx: AudioContext | null = null;
  private shotBuf: AudioBuffer | null = null;
  private loading: Promise<void> | null = null;

  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    void this.loadSamples();
  }

  shot(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const play = () => {
      if (!this.shotBuf) {
        void this.loadSamples();
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.shotBuf;
      const g = ctx.createGain();
      g.gain.value = 1;
      src.connect(g);
      g.connect(ctx.destination);
      src.start();
    };
    if (ctx.state === "suspended") {
      void ctx.resume().then(play);
      return;
    }
    play();
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.ctx = new AC();
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
      const shot = await this.fetchBuffer(ctx, "sfx/gunshot.mp3");
      if (shot) this.shotBuf = shot;
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
}

export const sfx = new Sfx();
