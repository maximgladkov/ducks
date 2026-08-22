import type { World } from "koota";
import type { Vec2 } from "gyro-aim";
import type { ControllerEvent, ControllerSample } from "@duckhunt/shared";
import { hitscan } from "gyro-aim";
import { diagEvery, diagLog, round, roundAll } from "../../diag";
import type { DebugSettings } from "../../gameSettings";
import { allAimTargets, hittableTargets } from "../spawn";
import { Aim, Crosshair, Player } from "../traits";

export function ingestSample(
  world: World,
  playerId: string,
  sample: ControllerSample,
  settings: DebugSettings,
): void {
  world.query(Player, Aim).updateEach(([player, aim]) => {
    if (player.id !== playerId) return;
    aim.session.setSettings(settings);
    aim.session.ingest(sample);
    aim.lastHostReceive = performance.now();
    aim.packets += 1;
  });
}

export function handlePlayerEvent(
  world: World,
  playerId: string,
  event: ControllerEvent,
  settings: DebugSettings,
  screen: Vec2,
  onCalibPoint: (playerId: string, seq: number) => void,
): { hitId: string | null; miss: boolean } {
  const entity = [...world.query(Player, Aim)].find(
    (e) => e.get(Player)?.id === playerId,
  );
  if (!entity) return { hitId: null, miss: false };
  const aim = entity.get(Aim)!;
  const p = entity.get(Player)!;
  aim.session.setSettings(settings);
  aim.session.setScreen(screen);

  if (event.type === "recentre") {
    aim.session.recentre();
    return { hitId: null, miss: false };
  }

  if (event.type === "calib_point") {
    onCalibPoint(p.id, event.seq);
    return { hitId: null, miss: false };
  }

  if (event.type === "trigger_down") {
    if (aim.session.calibrating) {
      onCalibPoint(p.id, aim.session.calibRays.length);
      return { hitId: null, miss: false };
    }
    const hittable = hittableTargets(world).map((t) => ({
      id: t.id ?? "",
      x: t.x,
      y: t.y,
      radius: t.radius,
    }));
    const fired = aim.session.aimAt(event.t, performance.now(), hittable);
    const hitId = hitscan(
      fired,
      hittable,
      settings.aimAssistEnabled ? 10 : 4,
    );
    const frameDelta = Math.hypot(
      fired[0] - aim.session.aim[0],
      fired[1] - aim.session.aim[1],
    );
    diagLog("trigger", {
      id: p.id,
      eventT: event.t,
      aimPx: roundAll(fired, 1),
      frameAimPx: roundAll(aim.session.aim, 1),
      deltaPx: round(frameDelta, 1),
      sampleAgeMs: round(aim.session.sampleAge, 1),
      horizonMs: round(aim.session.horizonMs, 1),
    });
    const targets = allAimTargets(world);
    const next = aim.session.learnDrift(targets);
    if (next) {
      diagLog("bias", {
        id: p.id,
        shots: aim.session.biasShots,
        biasDeg: roundAll(
          [
            (Math.atan(aim.session.aimBias[0]) * 180) / Math.PI,
            (Math.atan(aim.session.aimBias[1]) * 180) / Math.PI,
          ],
          3,
        ),
      });
    }
    aim.session.noteShot(fired, targets, hitId);
    if (hitId) return { hitId, miss: false };
    aim.missFlash = 1;
    return { hitId: null, miss: true };
  }

  return { hitId: null, miss: false };
}

export function updateAimFrames(
  world: World,
  settings: DebugSettings,
  screen: Vec2,
  dt: number,
  showGhosts: boolean,
): void {
  const targets = allAimTargets(world);
  world.query(Player, Aim, Crosshair).updateEach(([player, aim, cross]) => {
    aim.session.setSettings(settings);
    aim.session.setScreen(screen);
    aim.session.update(dt, performance.now(), targets);
    if (aim.missFlash > 0) {
      aim.missFlash = Math.max(0, aim.missFlash - dt * 4);
    }
    paintAim(player.id, aim, cross, showGhosts);
  });
}

function paintAim(
  id: string,
  aim: { session: import("gyro-aim").AimSession; missFlash: number },
  cross: {
    el: HTMLDivElement;
    wedge: HTMLDivElement;
    ghostRaw: HTMLDivElement;
    ghostFilt: HTMLDivElement;
    ghostPred: HTMLDivElement;
  },
  showGhosts: boolean,
): void {
  if (aim.session.calibrating) {
    cross.el.style.display = "none";
    cross.wedge.style.display = "none";
    cross.ghostRaw.style.display = "none";
    cross.ghostFilt.style.display = "none";
    cross.ghostPred.style.display = "none";
    return;
  }

  cross.el.style.display = "block";
  cross.el.style.transform = `translate3d(${aim.session.aim[0]}px, ${aim.session.aim[1]}px, 0)`;
  if (aim.missFlash > 0) {
    cross.el.classList.add("flash");
  } else {
    cross.el.classList.remove("flash");
  }

  if (aim.session.clamped) {
    cross.wedge.style.display = "block";
    const ang =
      (Math.atan2(aim.session.edge[1], aim.session.edge[0]) * 180) / Math.PI + 90;
    cross.wedge.style.transform = `translate(9px, -22px) rotate(${ang}deg)`;
  } else {
    cross.wedge.style.display = "none";
  }

  const display = showGhosts ? "block" : "none";
  cross.ghostRaw.style.display = display;
  cross.ghostFilt.style.display = display;
  cross.ghostPred.style.display = display;
  cross.ghostRaw.style.transform = `translate3d(${aim.session.raw[0]}px, ${aim.session.raw[1]}px, 0)`;
  cross.ghostFilt.style.transform = `translate3d(${aim.session.filtered[0]}px, ${aim.session.filtered[1]}px, 0)`;
  cross.ghostPred.style.transform = `translate3d(${aim.session.predicted[0]}px, ${aim.session.predicted[1]}px, 0)`;

  if (diagEvery(`aim:${id}`, 100)) {
    const sample = aim.session.lastSample;
    const plane = aim.session.samplePlane();
    diagLog("aim", {
      id,
      sensorQ: sample ? roundAll(sample.q) : null,
      sensorW: sample ? roundAll(sample.w) : null,
      sampleAgeMs: round(aim.session.sampleAge, 1),
      clockOffset: round(aim.session.clockOffset, 1),
      plane: plane ? roundAll(plane) : null,
      rawPx: roundAll(aim.session.raw, 1),
      filteredPx: roundAll(aim.session.filtered, 1),
      predictedPx: roundAll(aim.session.predicted, 1),
      horizonMs: round(aim.session.horizonMs, 1),
      rateQuality: round(aim.session.rateQuality, 3),
    });
  }
  if (diagEvery(`bench:${id}`, 500)) {
    const snap = aim.session.bench.snapshot();
    diagLog("bench", {
      id,
      staticRmsPx: snap.staticRmsPx != null ? round(snap.staticRmsPx, 2) : null,
      movingResidualPx:
        snap.movingResidualPx != null ? round(snap.movingResidualPx, 2) : null,
      yawDriftDegPerMin:
        snap.yawDriftDegPerMin != null ? round(snap.yawDriftDegPerMin, 3) : null,
      sampleAgeMs: round(snap.sampleAgeMs, 1),
      horizonMs: round(snap.horizonMs, 1),
      stillLock: aim.session.stillLock.locked(),
    });
  }
}
