import type { World } from "koota";
import { FloatScore, Position } from "../traits";

export type FloatScoreView = {
  x: number;
  y: number;
  text: string;
  t: number;
};

export function stepFloatScores(world: World, dt: number): void {
  world.query(FloatScore).updateEach(([score]) => {
    score.t += dt;
  });
  for (const entity of [...world.query(FloatScore)]) {
    if ((entity.get(FloatScore)?.t ?? 0) >= 0.9) entity.destroy();
  }
}

export function collectFloatScores(world: World): FloatScoreView[] {
  const out: FloatScoreView[] = [];
  world.query(Position, FloatScore).readEach(([pos, score]) => {
    out.push({ x: pos.x, y: pos.y, text: score.text, t: score.t });
  });
  return out;
}
