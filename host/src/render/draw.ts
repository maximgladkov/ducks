import type { World } from "koota";
import { WAVE_SHOTS, passLine } from "../rules";
import { type HudPlayerView, type HudState } from "../hud";
import { renderHudDom } from "../hudDom";
import {
  INTRO_ALERT,
  INTRO_SNIFF,
  matchContext,
  matchPhase,
  sniffProgress,
  type MatchActor,
} from "../machines/match";
import {
  drawDog,
  drawMeadowBack,
  drawMeadowFg,
  playfieldHeight,
} from "../scene";
import { duckFrame, type SpriteBank } from "../sprites";
import { drawSkyClouds, type SkyCloud } from "../clouds";
import { collectDucks } from "../ecs/systems/ducks";
import { collectFloatScores } from "../ecs/systems/scores";
import { Ammo, Player, Score } from "../ecs/traits";

export function collectPlayerViews(world: World): HudPlayerView[] {
  const out: HudPlayerView[] = [];
  world.query(Player, Score, Ammo).readEach(([player, score, ammo]) => {
    out.push({
      id: player.id,
      index: player.index,
      color: player.color,
      shots: ammo.shots,
      score: score.value,
    });
  });
  return out.sort((a, b) => a.index - b.index);
}

export function hudFromMatch(actor: MatchActor, hud: HudState): void {
  const ctx = matchContext(actor);
  const phase = matchPhase(actor);
  hud.round = ctx.round;
  hud.shots = phase === "wave" ? ctx.shots : WAVE_SHOTS;
  hud.hits = ctx.hits;
  hud.resolved = ctx.resolved;
  hud.score = ctx.score;
  hud.pass = passLine(ctx.round);
}

export function paintBanner(el: HTMLElement | null, banner: string | null): void {
  if (!el) return;
  if (banner) {
    el.textContent = banner;
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

export function drawFrame(opts: {
  sprites: SpriteBank | null;
  skyCtx: CanvasRenderingContext2D;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  clouds: SkyCloud[];
  world: World;
  match: MatchActor;
  hud: HudState;
  bannerEl: HTMLElement | null;
}): void {
  const { sprites, skyCtx, ctx, w, h, clouds, world, match, hud, bannerEl } =
    opts;
  if (!sprites) {
    skyCtx.fillStyle = "#3CBCFC";
    skyCtx.fillRect(0, 0, w, h);
    ctx.clearRect(0, 0, w, h);
    return;
  }
  skyCtx.imageSmoothingEnabled = false;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);

  drawMeadowBack(skyCtx, sprites, w, h);
  drawSkyClouds(skyCtx, sprites, clouds);

  const ctxMatch = matchContext(match);
  const phase = matchPhase(match);
  const playH = playfieldHeight(h);
  if (ctxMatch.skyTint) {
    skyCtx.fillStyle = "rgba(252, 116, 180, 0.45)";
    skyCtx.fillRect(0, 0, w, playH);
  }

  const dogT =
    ctxMatch.dogPose === "jump"
      ? Math.max(0, ctxMatch.phaseT - INTRO_SNIFF - INTRO_ALERT)
      : ctxMatch.phaseT;
  const dogOpts = { hold: ctxMatch.dogHold, walk: sniffProgress(match) };
  if (ctxMatch.dogPose === "jump") {
    drawDog(skyCtx, sprites, w, h, "jump", dogT, dogOpts);
  }

  drawMeadowFg(skyCtx, sprites, w, h);
  skyCtx.fillStyle = "#6B6B00";
  skyCtx.fillRect(0, playH, w, h - playH);

  if (ctxMatch.dogPose === "sniff" || ctxMatch.dogPose === "alert") {
    drawDog(skyCtx, sprites, w, h, ctxMatch.dogPose, dogT, dogOpts);
  }

  const ducks = collectDucks(world);
  for (const t of ducks) {
    const frame = duckFrame(sprites, t.kind, {
      vx: t.vx,
      vy: t.vy,
      life: t.life,
      flash: t.flash,
      falling: t.falling,
    });
    const scale = (t.radius * 2.6) / 34;
    const dw = frame.width * scale;
    const dh = frame.height * scale;
    ctx.save();
    ctx.translate(t.x, t.y);
    if (!t.falling && t.flash <= 0 && t.vx < 0) ctx.scale(-1, 1);
    ctx.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  if (ctxMatch.dogPose === "got" || ctxMatch.dogPose === "laugh") {
    drawDog(ctx, sprites, w, h, ctxMatch.dogPose, dogT, dogOpts);
  }

  if (phase === "title") {
    const titleSize = Math.max(14, Math.round(w * 0.024));
    const subSize = Math.max(9, Math.round(w * 0.014));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.imageSmoothingEnabled = false;
    for (const t of ducks) {
      const title =
        t.tag === "titleA" ? "GAME A" : t.tag === "titleB" ? "GAME B" : null;
      const sub =
        t.tag === "titleA" ? "1 DUCK" : t.tag === "titleB" ? "2 DUCKS" : null;
      if (!title || !sub) continue;
      const top = t.y + t.radius + 12;
      ctx.font = `${titleSize}px "Press Start 2P"`;
      ctx.fillStyle = "#fcfcfc";
      ctx.fillText(title, t.x, top);
      ctx.font = `${subSize}px "Press Start 2P"`;
      ctx.fillStyle = "#fcb400";
      ctx.fillText(sub, t.x, top + titleSize + 10);
      ctx.fillStyle = "#bcbcbc";
      ctx.fillText("3 SHOTS", t.x, top + titleSize + subSize + 20);
    }
  }

  ctx.font = `${Math.max(10, Math.round(w * 0.018))}px "Press Start 2P"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const f of collectFloatScores(world)) {
    ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9);
    ctx.fillStyle = "#fcfcfc";
    ctx.fillText(f.text, f.x, f.y - f.t * 48);
  }
  ctx.globalAlpha = 1;

  hudFromMatch(match, hud);
  renderHudDom(hud, collectPlayerViews(world));
  paintBanner(bannerEl, ctxMatch.banner);
}
