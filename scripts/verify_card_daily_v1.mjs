import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PREFIX = "window.YOUBIKE_CARD_DAILY=";
const DAILY_PREFIX = "window.YOUBIKE_DAILY_V2=";
const EXPECTED_MONTHS = ["2026-07", "2026-08", "2026-09"];
const FORBIDDEN_RAW_LABELS = ["帳號", "訂單號", "外觀卡號", "完整卡號"];
const FORBIDDEN_PROPERTY_NAMES = new Set([
  "account",
  "accountid",
  "account_id",
  "order",
  "orderid",
  "order_id",
  "fullcard",
  "full_card",
  "cardnumber",
  "card_number",
  "帳號",
  "訂單號",
  "外觀卡號",
  "完整卡號",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dataDir = path.join(repoRoot, "dist", "data");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertNoForbiddenPropertyNames(value, location = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPropertyNames(item, `${location}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    assert(
      !FORBIDDEN_PROPERTY_NAMES.has(key.toLowerCase()),
      `${location} contains a forbidden identifier property`,
    );
    assertNoForbiddenPropertyNames(child, `${location}.${key}`);
  }
}

function parsePayload(raw, fileLabel) {
  assert(raw.startsWith(PREFIX), `${fileLabel}: invalid window.YOUBIKE_CARD_DAILY prefix`);
  const body = raw.slice(PREFIX.length).trim();
  assert(body.endsWith(";"), `${fileLabel}: payload must end with a semicolon`);

  for (const label of FORBIDDEN_RAW_LABELS) {
    assert(!raw.includes(label), `${fileLabel}: contains a forbidden identifier field label`);
  }

  try {
    return JSON.parse(body.slice(0, -1));
  } catch {
    throw new Error(`${fileLabel}: payload is not valid JSON`);
  }
}

function parseWrappedJson(raw, prefix, fileLabel) {
  assert(raw.startsWith(prefix), `${fileLabel}: invalid wrapper prefix`);
  const body = raw.slice(prefix.length).trim();
  assert(body.endsWith(";"), `${fileLabel}: payload must end with a semicolon`);
  return JSON.parse(body.slice(0, -1));
}

function validatePayload(payload, expectedMonth, fileLabel) {
  assert(isPlainObject(payload), `${fileLabel}: payload must be an object`);
  assert(
    hasExactKeys(payload, ["version", "month", "dates", "cards", "meta"]),
    `${fileLabel}: unexpected top-level schema`,
  );
  assert(payload.month === expectedMonth, `${fileLabel}: month does not match filename`);
  assert(Array.isArray(payload.dates) && payload.dates.length > 0, `${fileLabel}: dates must be non-empty`);
  assert(isPlainObject(payload.cards), `${fileLabel}: cards must be an object`);
  assert(isPlainObject(payload.meta), `${fileLabel}: meta must be an object`);
  assertNoForbiddenPropertyNames(payload);

  const seenDates = new Set();
  let previousDate = "";
  payload.dates.forEach((dateText, dateIndex) => {
    assert(
      typeof dateText === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateText),
      `${fileLabel}: invalid date at date index ${dateIndex}`,
    );
    assert(dateText.startsWith(`${expectedMonth}-`), `${fileLabel}: date is outside the expected month`);
    const parsed = new Date(`${dateText}T00:00:00Z`);
    assert(!Number.isNaN(parsed.getTime()), `${fileLabel}: unparseable date at date index ${dateIndex}`);
    assert(parsed.toISOString().slice(0, 10) === dateText, `${fileLabel}: nonexistent calendar date`);
    assert(!seenDates.has(dateText), `${fileLabel}: duplicate date`);
    assert(previousDate === "" || dateText > previousDate, `${fileLabel}: dates are not strictly ascending`);
    seenDates.add(dateText);
    previousDate = dateText;
  });

  let fullEvents = 0;
  let emptyEvents = 0;
  let collisionSuffixCount = 0;
  let cardOrdinal = 0;

  for (const [suffix, record] of Object.entries(payload.cards)) {
    cardOrdinal += 1;
    const location = `${fileLabel}: card record ${cardOrdinal}`;
    assert(Array.from(suffix).length === 5, `${location} key is not exactly five characters`);
    assert(!/[\s-]/u.test(suffix), `${location} key contains disallowed separators`);
    assert(isPlainObject(record) && hasExactKeys(record, ["n", "d"]), `${location} has unexpected schema`);
    assert(Number.isInteger(record.n) && record.n > 0, `${location} n must be a positive integer`);
    assert(Array.isArray(record.d), `${location} d must be an array`);
    if (record.n > 1) collisionSuffixCount += 1;

    const seenDateIndices = new Set();
    record.d.forEach((dailyCounts, dailyOrdinal) => {
      const dailyLocation = `${location}, daily record ${dailyOrdinal + 1}`;
      assert(Array.isArray(dailyCounts) && dailyCounts.length === 3, `${dailyLocation} must have three values`);
      const [dateIndex, fullCount, emptyCount] = dailyCounts;
      assert(
        Number.isInteger(dateIndex) && dateIndex >= 0 && dateIndex < payload.dates.length,
        `${dailyLocation} date index is out of range`,
      );
      assert(!seenDateIndices.has(dateIndex), `${dailyLocation} duplicates a date index`);
      assert(Number.isInteger(fullCount) && fullCount >= 0, `${dailyLocation} full count is invalid`);
      assert(Number.isInteger(emptyCount) && emptyCount >= 0, `${dailyLocation} empty count is invalid`);
      assert(fullCount + emptyCount > 0, `${dailyLocation} contains no events`);
      seenDateIndices.add(dateIndex);
      fullEvents += fullCount;
      emptyEvents += emptyCount;
    });
  }

  assert(Number.isInteger(payload.meta.suffixLength) && payload.meta.suffixLength === 5, `${fileLabel}: meta suffixLength mismatch`);
  assert(Number.isInteger(payload.meta.suffixCount), `${fileLabel}: meta suffixCount must be an integer`);
  assert(payload.meta.suffixCount === cardOrdinal, `${fileLabel}: meta suffixCount mismatch`);
  assert(Number.isInteger(payload.meta.collisionSuffixCount), `${fileLabel}: collisionSuffixCount must be an integer`);
  assert(
    payload.meta.collisionSuffixCount === collisionSuffixCount,
    `${fileLabel}: meta collisionSuffixCount mismatch`,
  );
  assert(Number.isInteger(payload.meta.fullEvents), `${fileLabel}: meta fullEvents must be an integer`);
  assert(payload.meta.fullEvents === fullEvents, `${fileLabel}: meta fullEvents mismatch`);
  assert(Number.isInteger(payload.meta.emptyEvents), `${fileLabel}: meta emptyEvents must be an integer`);
  assert(payload.meta.emptyEvents === emptyEvents, `${fileLabel}: meta emptyEvents mismatch`);
  return { fullEvents, emptyEvents };
}

function dailyHeatmapTotals(month) {
  const fileLabel = `daily-${month}.js`;
  const filePath = path.join(dataDir, fileLabel);
  assert(fs.existsSync(filePath), `${fileLabel}: file is missing`);
  const payload = parseWrappedJson(fs.readFileSync(filePath, "utf8"), DAILY_PREFIX, fileLabel);
  let fullEvents = 0;
  let emptyEvents = 0;
  for (const date of payload.dailyActivity || []) {
    for (const bucket of date || []) {
      for (const row of bucket || []) {
        fullEvents += Number(row[1] || 0);
        emptyEvents += Number(row[2] || 0);
      }
    }
  }
  return { fullEvents, emptyEvents };
}

for (const month of EXPECTED_MONTHS) {
  const fileLabel = `cards-${month}.js`;
  const filePath = path.join(dataDir, fileLabel);
  assert(fs.existsSync(filePath), `${fileLabel}: file is missing`);
  const raw = fs.readFileSync(filePath, "utf8");
  const payload = parsePayload(raw, fileLabel);
  const cardTotals = validatePayload(payload, month, fileLabel);
  const heatmapTotals = dailyHeatmapTotals(month);
  assert(cardTotals.fullEvents === heatmapTotals.fullEvents, `${fileLabel}: full-event total differs from heatmap daily payload`);
  assert(cardTotals.emptyEvents === heatmapTotals.emptyEvents, `${fileLabel}: empty-event total differs from heatmap daily payload`);
  process.stdout.write(`PASS ${fileLabel}\n`);
}

process.stdout.write(`Verified ${EXPECTED_MONTHS.length} card-daily payload files.\n`);
