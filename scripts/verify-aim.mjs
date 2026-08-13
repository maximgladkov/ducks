import { readFileSync } from "node:fs";

const records = readFileSync(process.argv[2] ?? "debug-log.jsonl", "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const benches = records.filter((r) => r.kind === "bench");
const triggers = records.filter((r) => r.kind === "trigger");
const aims = records.filter((r) => r.kind === "aim");

const avg = (values) =>
  values.length === 0
    ? null
    : values.reduce((s, v) => s + v, 0) / values.length;

const nums = (rows, key) =>
  rows.map((r) => r[key]).filter((v) => typeof v === "number");

console.log("Aim bench replay");
console.log(
  `  static jitter (px rms): ${avg(nums(benches, "staticRmsPx"))?.toFixed(2) ?? "—"}`,
);
console.log(
  `  moving path residual (px): ${avg(nums(benches, "movingResidualPx"))?.toFixed(2) ?? "—"}`,
);
console.log(
  `  yaw drift (deg/min): ${avg(nums(benches, "yawDriftDegPerMin"))?.toFixed(3) ?? "—"}`,
);
console.log(
  `  sample age (ms): ${avg(nums(benches, "sampleAgeMs"))?.toFixed(1) ?? "—"}`,
);
console.log(
  `  horizon (ms): ${avg(nums(benches, "horizonMs"))?.toFixed(1) ?? "—"}`,
);
console.log(
  `  trigger vs frame aim (px): ${avg(nums(triggers, "deltaPx"))?.toFixed(2) ?? "—"} (${triggers.length} shots)`,
);
if (aims.length) {
  console.log(`  aim frames logged: ${aims.length}`);
}
if (benches.length === 0 && triggers.length === 0) {
  console.log("no bench or trigger records in the log");
}
