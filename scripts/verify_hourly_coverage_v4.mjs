import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadWindowScript(relativePath, globalName) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, relativePath), "utf8"), context, { filename: relativePath });
  return context.window[globalName];
}

function mergeHour(daily, dateIndex, hour) {
  const merged = new Map();
  for (const slot of [hour * 2, hour * 2 + 1]) {
    for (const row of daily.dailyActivity[dateIndex]?.[slot] || []) {
      const values = merged.get(row[0]) || [0, 0, 0, 0, 0, 0];
      for (let index = 0; index < 6; index += 1) values[index] += Number(row[index + 1] || 0);
      merged.set(row[0], values);
    }
  }
  return merged;
}

const daily = loadWindowScript("dist/data/daily-2026-09.js", "YOUBIKE_DAILY_V2");
const monthly = loadWindowScript("dist/data/heatmap-2026-09.js", "YOUBIKE_HEATMAP_DATA");
const rules = [
  { label: "調出／滿借", event: 0, actions: [2] },
  { label: "綁車／滿借", event: 0, actions: [3] },
  { label: "調入／空還", event: 1, actions: [4] },
  { label: "解車／空還", event: 1, actions: [5] },
  { label: "調出＋綁車／滿借", event: 0, actions: [2, 3] },
  { label: "調入＋解車／空還", event: 1, actions: [4, 5] },
];

let checkedBuckets = 0;
for (let dateIndex = 0; dateIndex < daily.dates.length; dateIndex += 1) {
  for (let hour = 0; hour < 24; hour += 1) {
    const rows = mergeHour(daily, dateIndex, hour);
    for (const rule of rules) {
      let event = 0;
      let covered = 0;
      for (const values of rows.values()) {
        const eventPresent = Number(values[rule.event] || 0) > 0;
        const actionPresent = rule.actions.some((index) => Number(values[index] || 0) > 0);
        if (eventPresent) event += 1;
        if (eventPresent && actionPresent) covered += 1;
      }
      if (covered > event) throw new Error(`${daily.dates[dateIndex].date} ${hour}時 ${rule.label}: ${covered} > ${event}`);
      checkedBuckets += 1;
    }
  }
}

const targetIndex = monthly.stations.findIndex((station) => station[0] === "舊莊派出所");
if (targetIndex < 0) throw new Error("找不到回歸場站：舊莊派出所");
const dateIndex = daily.dates.findIndex((item) => item.date === "2026-09-01");
const firstHalf = new Map((daily.dailyActivity[dateIndex]?.[12] || []).map((row) => [row[0], row.slice(1, 7)])).get(targetIndex) || [0, 0, 0, 0, 0, 0];
const secondHalf = new Map((daily.dailyActivity[dateIndex]?.[13] || []).map((row) => [row[0], row.slice(1, 7)])).get(targetIndex) || [0, 0, 0, 0, 0, 0];
const hourly = mergeHour(daily, dateIndex, 6).get(targetIndex) || [0, 0, 0, 0, 0, 0];
if (!(firstHalf[2] > 0 && secondHalf[0] > 0 && hourly[2] > 0 && hourly[0] > 0)) {
  throw new Error(`跨半小時回歸案例失敗：${JSON.stringify({ firstHalf, secondHalf, hourly })}`);
}

console.log(JSON.stringify({
  status: "ok",
  checkedBuckets,
  regressionCase: {
    date: "2026-09-01",
    hour: 6,
    station: "舊莊派出所",
    firstHalf,
    secondHalf,
    hourly,
    covered: true,
  },
}, null, 2));
