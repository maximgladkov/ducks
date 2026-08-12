export type OneEuroParams = {
  minCutoff: number;
  beta: number;
  dCutoff?: number;
};

export class OneEuroFilter1D {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;
  private params: OneEuroParams;

  constructor(params: OneEuroParams) {
    this.params = { dCutoff: 1, ...params };
  }

  setParams(params: Partial<OneEuroParams>): void {
    this.params = { ...this.params, ...params };
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  filter(x: number, t: number): number {
    if (this.tPrev === null || this.xPrev === null) {
      this.tPrev = t;
      this.xPrev = x;
      return x;
    }
    const dt = Math.max(1e-6, t - this.tPrev);
    const dx = (x - this.xPrev) / dt;
    const edx = expSmooth(
      dx,
      this.dxPrev,
      alpha(dt, this.params.dCutoff ?? 1),
    );
    this.dxPrev = edx;
    const cutoff = this.params.minCutoff + this.params.beta * Math.abs(edx);
    const result = expSmooth(x, this.xPrev, alpha(dt, cutoff));
    this.xPrev = result;
    this.tPrev = t;
    return result;
  }
}

export class OneEuroFilter2D {
  private fx: OneEuroFilter1D;
  private fy: OneEuroFilter1D;

  constructor(params: OneEuroParams) {
    this.fx = new OneEuroFilter1D(params);
    this.fy = new OneEuroFilter1D(params);
  }

  setParams(params: Partial<OneEuroParams>): void {
    this.fx.setParams(params);
    this.fy.setParams(params);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }

  filter(x: number, y: number, t: number): [number, number] {
    return [this.fx.filter(x, t), this.fy.filter(y, t)];
  }
}

function alpha(dt: number, cutoff: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoff));
  return 1 / (1 + tau / dt);
}

function expSmooth(x: number, prev: number, a: number): number {
  return a * x + (1 - a) * prev;
}
