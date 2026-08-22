import { readFileSync } from "node:fs";
import {
  applyHomography,
  clampToSafeDomain,
  fitPlaneToScreen,
  homographyJacobian,
} from "gyro-aim";

const records = readFileSync(process.argv[2] ?? "debug-log.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const report = records.find((r) => r.kind === "calib_report" && r.homography);
if (!report) {
  console.log("no calibration report in the log");
  process.exit(0);
}
const H = report.homography;
const screen = records.find((r) => r.kind === "session")?.screen ?? [1631, 1037];

const gainAt = (h, plane) => {
  const [a, b, c, d] = homographyJacobian(h, plane);
  const deg = Math.PI / 180;
  const sx = (1 + plane[0] ** 2) * deg;
  const sy = (1 + plane[1] ** 2) * deg;
  const j = [a * sx, b * sy, c * sx, d * sy];
  return Math.sqrt(
    (j[0] ** 2 + j[1] ** 2 + j[2] ** 2 + j[3] ** 2) / 2 +
      Math.sqrt(
        Math.max(
          0,
          ((j[0] ** 2 + j[1] ** 2 - j[2] ** 2 - j[3] ** 2) / 2) ** 2 +
            (j[0] * j[2] + j[1] * j[3]) ** 2,
        ),
      ),
  );
};

console.log("Sensitivity in pixels per degree, aiming up from the calibrated centre:");
console.log("  degrees   before      after");
for (const deg of [0, 10, 20, 30, 40, 45, 49, 55, 70]) {
  const plane = [0, -Math.tan((deg * Math.PI) / 180)];
  const before = gainAt(H, plane);
  const after = gainAt(H, clampToSafeDomain(H, plane));
  console.log(
    `  ${String(deg).padStart(5)}   ${before.toFixed(0).padStart(8)}   ${after.toFixed(0).padStart(8)}`,
  );
}

let worstBefore = 0;
let worstAfter = 0;
for (let x = -3; x <= 3; x += 0.05) {
  for (let y = -3; y <= 3; y += 0.05) {
    worstBefore = Math.max(worstBefore, gainAt(H, [x, y]));
    worstAfter = Math.max(worstAfter, gainAt(H, clampToSafeDomain(H, [x, y])));
  }
}
console.log(
  `\nWorst sensitivity anywhere in the aim range: ${worstBefore.toFixed(0)} -> ${worstAfter.toFixed(0)} px/deg`,
);

// The clamp must not disturb aiming at the screen itself.
const planes = (report.chosenPlanes ?? []).filter(Boolean);
let worstShift = 0;
for (const p of planes) {
  const a = applyHomography(H, p);
  const b = applyHomography(H, clampToSafeDomain(H, p));
  worstShift = Math.max(worstShift, Math.hypot(a[0] - b[0], a[1] - b[1]));
}
console.log(`Movement of the nine calibration points: ${worstShift.toFixed(4)} px`);

const targets = report.targets ?? [];
if (planes.length === targets.length && planes.length >= 5) {
  const fit = fitPlaneToScreen(planes, targets);
  console.log(
    `\nRefitting this session's captures now chooses the ${fit.model} mapping,` +
      ` held-out error ${fit.maxError.toFixed(1)}px (worst) / ${fit.meanError.toFixed(1)}px (mean).`,
  );
  console.log(
    `  its projective terms: h31=${fit.H[6].toFixed(6)}, h32=${fit.H[7].toFixed(6)}`,
  );
  const gains = planes.map((p) => gainAt(fit.H, p));
  console.log(
    `  sensitivity across the screen: ${Math.min(...gains).toFixed(0)}..${Math.max(...gains).toFixed(0)} px/deg`,
  );
}
