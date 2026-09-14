(() => {
  "use strict";

  const MONTHS = window.YOUBIKE_HEATMAP_MONTHS;
  const ACTIVITY = ["滿借", "空還", "調出", "綁車", "調入", "解綁車"];
  const RATES = ["見車率", "見位率"];
  const METRICS = [...ACTIVITY, ...RATES];
  const COLORS = {
    "滿借": "#e65b3a",
    "空還": "#22a56d",
    "調出": "#2474d2",
    "綁車": "#16a9bb",
    "調入": "#7b55cc",
    "解綁車": "#d54f9b",
    "見車率": "#ec9b23",
    "見位率": "#52677f"
  };
  const DEFAULT_METRICS = ["調出", "綁車", "調入", "解綁車"];
  const PAGE_SIZE = 100;
  const state = {
    month: MONTHS?.defaultMonth || "2026-09",
    slot: 16,
    page: 1,
    playing: false,
    playTimer: null,
    query: ""
  };
  let monthData = null;
  let dailyData = null;
  let monthInfo = null;
  let stations = [];
  let detailRows = [];
  let currentFilteredStations = [];
  let currentDateMaps = new Map();
  let refreshQueued = false;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 2 });
  const fmtOne = new Intl.NumberFormat("zh-TW", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 9 }).setView([25.0478, 121.5447], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  const markerLayer = L.layerGroup().addTo(map);

  function showLoading(text = "載入逐日資料…") {
    $("loadingText").textContent = text;
    $("loading").classList.remove("hidden");
  }

  function hideLoading() {
    $("loading").classList.add("hidden");
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.add("show");
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2300);
  }

  function slotStart(slot) {
    const hour = String(Math.floor(slot / 2)).padStart(2, "0");
    return `${hour}:${slot % 2 ? "30" : "00"}`;
  }

  function slotLabel(slot) {
    const hour = String(Math.floor(slot / 2)).padStart(2, "0");
    return `${slotStart(slot)}–${hour}:${slot % 2 ? "59" : "29"}`;
  }

  function gradeFor(city, usage) {
    if (!Number.isFinite(usage)) return "—";
    if (city === "台北市") return usage >= 200 ? "A" : usage >= 100 ? "B" : "C";
    if (city === "新北市") return usage >= 100 ? "A" : usage >= 50 ? "B" : "C";
    return "—";
  }

  function safeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function loadScript(src, key) {
    document.querySelectorAll(`script[data-data-key="${key}"]`).forEach((node) => node.remove());
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${src}${src.includes("?") ? "&" : "?"}v=${encodeURIComponent(monthInfo?.revision || "v2")}`;
      script.dataset.dataKey = key;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`無法載入 ${src}`));
      document.head.appendChild(script);
    });
  }

  function checkedValues(containerId) {
    return [...$(containerId).querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  }

  function setChecked(containerId, values) {
    const wanted = new Set(values);
    $(containerId).querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = wanted.has(input.value); });
  }

  function checkbox(label, value, checked = true, extraClass = "", color = "") {
    const row = document.createElement("label");
    if (extraClass) row.className = extraClass;
    row.innerHTML = `<input type="checkbox" value="${safeText(value)}" ${checked ? "checked" : ""}>${color ? `<i class="metric-chip" style="background:${color}"></i>` : ""}<span>${safeText(label)}</span>`;
    return row;
  }

  function populateStaticControls() {
    $("monthSelect").innerHTML = MONTHS.months.map((item) => `<option value="${item.id}" ${item.id === state.month ? "selected" : ""}>${safeText(item.label)}</option>`).join("");
    $("dayOptions").replaceChildren(checkbox("平日", "平日", true), checkbox("假日", "假日", false));
    $("cityOptions").replaceChildren(checkbox("台北市", "台北市", true), checkbox("新北市", "新北市", true));
    $("gradeOptions").replaceChildren(checkbox("A 級", "A", true), checkbox("B 級", "B", true), checkbox("C 級", "C", true));
    $("metricOptions").replaceChildren(...METRICS.map((metric) => checkbox(metric, metric, DEFAULT_METRICS.includes(metric), "", COLORS[metric])));
  }

  function buildDates() {
    const nodes = dailyData.dates.map((item) => {
      const [year, month, day] = item.date.split("-");
      return checkbox(`${Number(month)}/${Number(day)} ${item.weekday}`, item.date, true, item.dayType === "假日" ? "holiday" : "");
    });
    $("dateOptions").replaceChildren(...nodes);
  }

  function buildDistricts(checkAll = true) {
    const prior = new Set(checkedValues("districtOptions"));
    const cities = new Set(checkedValues("cityOptions"));
    const districts = [...new Set(stations.filter((station) => cities.has(station.city)).map((station) => station.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const nodes = districts.map((district) => checkbox(district, district, checkAll || prior.has(district)));
    $("districtOptions").replaceChildren(...nodes);
  }

  async function loadMonth(monthId, preserve = false) {
    showLoading("載入月別與逐日資料…");
    state.month = monthId;
    state.page = 1;
    monthInfo = MONTHS.months.find((item) => item.id === monthId) || MONTHS.months[0];
    try {
      window.YOUBIKE_HEATMAP_DATA = undefined;
      await loadScript(monthInfo.src, "monthly");
      monthData = window.YOUBIKE_HEATMAP_DATA;
      if (!monthData) throw new Error("月別資料格式錯誤");
      window.YOUBIKE_DAILY_V2 = undefined;
      await loadScript(monthInfo.dailySrc, "daily");
      dailyData = window.YOUBIKE_DAILY_V2;
      if (!dailyData || dailyData.month !== monthId) throw new Error("逐日資料格式錯誤");
      stations = monthData.stations.map((row, index) => {
        const usageValue = Number(monthData.dailyUsage?.[index]);
        const usage = Number.isFinite(usageValue) ? usageValue : null;
        return {
          index,
          name: row[0],
          city: String(row[1] || "").replace("臺", "台"),
          district: row[2] || "",
          lat: Number(row[3]),
          lng: Number(row[4]),
          code: row[5] || "",
          usage,
          grade: gradeFor(String(row[1] || "").replace("臺", "台"), usage)
        };
      });
      buildDates();
      buildDistricts(true);
      if (!preserve) {
        setChecked("dayOptions", ["平日"]);
        setChecked("cityOptions", ["台北市", "新北市"]);
        setChecked("gradeOptions", ["A", "B", "C"]);
        setChecked("metricOptions", DEFAULT_METRICS);
        $("usageThreshold").value = "100";
        $("stationSearch").value = "";
        state.query = "";
      }
      queueRefresh(true);
    } catch (error) {
      console.error(error);
      toast(`載入失敗：${error.message}`);
    } finally {
      hideLoading();
    }
  }

  function effectiveDateIndices() {
    const checkedDates = new Set(checkedValues("dateOptions"));
    const dayTypes = new Set(checkedValues("dayOptions"));
    return dailyData.dates.map((item, index) => ({ ...item, index })).filter((item) => checkedDates.has(item.date) && dayTypes.has(item.dayType));
  }

  function filteredStationIndices() {
    const cities = new Set(checkedValues("cityOptions"));
    const districts = new Set(checkedValues("districtOptions"));
    const grades = new Set(checkedValues("gradeOptions"));
    const threshold = Number($("usageThreshold").value || 0);
    const query = state.query.trim().toLocaleLowerCase("zh-Hant");
    return stations.filter((station) => (
      cities.has(station.city) &&
      districts.has(station.district) &&
      grades.has(station.grade) &&
      Number.isFinite(station.usage) && station.usage > threshold &&
      (!query || `${station.name} ${station.code}`.toLocaleLowerCase("zh-Hant").includes(query))
    )).map((station) => station.index);
  }

  function buildActivity(dateItems) {
    const sums = new Float64Array(stations.length * ACTIVITY.length);
    const byDate = new Map();
    for (const item of dateItems) {
      const bucket = dailyData.dailyActivity[item.index]?.[state.slot] || [];
      const mapForDate = new Map();
      for (const row of bucket) {
        const values = row.slice(1, 7);
        mapForDate.set(row[0], values);
        for (let metric = 0; metric < ACTIVITY.length; metric += 1) sums[row[0] * ACTIVITY.length + metric] += Number(values[metric] || 0);
      }
      byDate.set(item.index, mapForDate);
    }
    const denominator = dateItems.length || 1;
    return { sums, denominator, byDate };
  }

  function buildRates(dateItems) {
    const output = new Map();
    if (!monthData || !dateItems.length) return output;
    const dayWeights = dateItems.reduce((acc, item) => ({ ...acc, [item.dayType]: (acc[item.dayType] || 0) + 1 }), {});
    for (const metric of RATES) {
      const sourceIndex = monthData.metrics.indexOf(metric) + 1;
      const sum = new Float64Array(stations.length);
      const weight = new Float64Array(stations.length);
      for (const [dayType, dayWeight] of Object.entries(dayWeights)) {
        const rows = monthData.values?.[dayType]?.[Math.floor(state.slot / 2)] || [];
        for (const row of rows) {
          const value = Number(row[sourceIndex]);
          if (!Number.isFinite(value)) continue;
          sum[row[0]] += value * dayWeight;
          weight[row[0]] += dayWeight;
        }
      }
      output.set(metric, { sum, weight });
    }
    return output;
  }

  function valueFor(stationIndex, metric, activity, rates) {
    const activityIndex = ACTIVITY.indexOf(metric);
    if (activityIndex >= 0) return activity.sums[stationIndex * ACTIVITY.length + activityIndex] / activity.denominator;
    const rate = rates.get(metric);
    return rate && rate.weight[stationIndex] ? rate.sum[stationIndex] / rate.weight[stationIndex] : null;
  }

  function quantile(values, q) {
    if (!values.length) return 1;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] || 1;
  }

  function markerIcon(metricValues, maxima, isFocus) {
    const visible = metricValues.filter((item) => Number.isFinite(item.value) && item.value > 0);
    const dots = visible.map(({ metric, value }) => {
      const maximum = metric.includes("率") ? 100 : maxima.get(metric) || 1;
      const size = Math.round(8 + 16 * Math.sqrt(Math.min(1, value / maximum)));
      const rateClass = metric.includes("率") ? " glyph-rate" : "";
      return `<i class="glyph-dot${rateClass}" title="${metric} ${fmt.format(value)}" style="width:${size}px;height:${size}px;background:${COLORS[metric]};border-color:${metric.includes("率") ? COLORS[metric] : "rgba(255,255,255,.92)"}"></i>`;
    }).join("");
    const columns = visible.length === 1 ? "single" : "";
    const side = visible.length <= 1 ? 28 : visible.length <= 4 ? 48 : 60;
    return L.divIcon({ className: "", html: `<div class="station-glyph ${columns} ${isFocus ? "focus" : ""}">${dots}</div>`, iconSize: [side, side], iconAnchor: [side / 2, side / 2] });
  }

  function popupHtml(station, metricValues, dateCount) {
    const rows = metricValues.map(({ metric, value }) => `<span><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${COLORS[metric]};margin-right:6px"></i>${metric}</span><b>${value == null ? "—" : `${fmt.format(value)}${metric.includes("率") ? "%" : ""}`}</b>`).join("");
    return `<div class="popup-title">${safeText(station.name)}</div><div class="popup-meta">${safeText(station.city)} ${safeText(station.district)} · ${safeText(station.code)} · ${station.grade}級 · 日均 ${fmt.format(station.usage)}</div><div class="popup-grid">${rows}</div><div class="popup-meta" style="margin:9px 0 0">活動值為 ${dateCount} 日含零平均；率值為月別平假日參考值。</div>`;
  }

  function renderMap(filtered, dateItems, activity, rates, selectedMetrics) {
    markerLayer.clearLayers();
    const valuesByStation = new Map();
    const samples = new Map(selectedMetrics.map((metric) => [metric, []]));
    for (const stationIndex of filtered) {
      const values = selectedMetrics.map((metric) => ({ metric, value: valueFor(stationIndex, metric, activity, rates) }));
      valuesByStation.set(stationIndex, values);
      values.forEach(({ metric, value }) => { if (Number.isFinite(value) && value > 0 && !metric.includes("率")) samples.get(metric).push(value); });
    }
    const maxima = new Map(selectedMetrics.map((metric) => [metric, metric.includes("率") ? 100 : quantile(samples.get(metric), .95)]));
    const query = state.query.trim().toLocaleLowerCase("zh-Hant");
    let plotted = 0;
    for (const stationIndex of filtered) {
      const station = stations[stationIndex];
      const values = valuesByStation.get(stationIndex);
      if (!values.some((item) => Number.isFinite(item.value) && item.value > 0)) continue;
      const focus = Boolean(query && `${station.name} ${station.code}`.toLocaleLowerCase("zh-Hant").includes(query));
      L.marker([station.lat, station.lng], { icon: markerIcon(values, maxima, focus), riseOnHover: true })
        .bindPopup(popupHtml(station, values, dateItems.length))
        .addTo(markerLayer);
      plotted += 1;
    }
    return { plotted, valuesByStation };
  }

  function buildDetailRows(filtered, dateItems, byDate) {
    const rows = [];
    for (const item of dateItems) {
      const dateMap = byDate.get(item.index) || new Map();
      for (const stationIndex of filtered) {
        rows.push([item.index, stationIndex, ...(dateMap.get(stationIndex) || [0, 0, 0, 0, 0, 0])]);
      }
    }
    return rows;
  }

  function renderDetail() {
    const pages = Math.max(1, Math.ceil(detailRows.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const rows = detailRows.slice(start, start + PAGE_SIZE);
    $("detailBody").innerHTML = rows.map((row) => {
      const date = dailyData.dates[row[0]];
      const station = stations[row[1]];
      const cells = row.slice(2).map((value) => `<td class="${value === 0 ? "zero" : ""}">${fmt.format(value)}</td>`).join("");
      return `<tr title="${safeText(station.city)} ${safeText(station.district)} · ${safeText(station.code)}"><td>${date.date.slice(5)}<br><small>${date.weekday}</small></td><td>${safeText(station.name)}</td><td><span class="grade grade-${station.grade}">${station.grade}</span></td>${cells}</tr>`;
    }).join("");
    $("pageText").textContent = `第 ${state.page} / ${pages} 頁`;
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
  }

  function renderLegend(selectedMetrics) {
    $("legendItems").innerHTML = selectedMetrics.map((metric) => `<div class="legend-item" style="color:${COLORS[metric]}"><i class="legend-dot" style="background:${metric.includes("率") ? "transparent" : COLORS[metric]}"></i><span style="color:var(--ink)">${metric}${metric.includes("率") ? "（月別）" : ""}</span></div>`).join("") || `<span style="font-size:11px;color:var(--muted)">請至少選擇一項指標</span>`;
  }

  function renderKpis(filtered, selectedMetrics, valuesByStation) {
    const cards = selectedMetrics.slice(0, 6).map((metric) => {
      const values = filtered.map((index) => valuesByStation.get(index)?.find((item) => item.metric === metric)?.value).filter(Number.isFinite);
      const total = metric.includes("率") ? (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0) : values.reduce((sum, value) => sum + value, 0);
      return `<div class="map-kpi"><span><i style="background:${COLORS[metric]}"></i>${metric}${metric.includes("率") ? "站均" : "平均總量"}</span><strong>${fmtOne.format(total)}${metric.includes("率") ? "%" : ""}</strong></div>`;
    });
    $("mapKpis").innerHTML = cards.join("");
  }

  function updateSummaries(dateItems, filtered, selectedMetrics, plotted) {
    const checkedDates = checkedValues("dateOptions");
    const days = checkedValues("dayOptions");
    const cities = checkedValues("cityOptions");
    const grades = checkedValues("gradeOptions");
    const districts = checkedValues("districtOptions");
    $("dateSummary").textContent = checkedDates.length === dailyData.dates.length ? `全部 ${checkedDates.length} 日` : `${checkedDates.length} 日已勾選`;
    $("daySummary").textContent = days.length === 2 ? "平日＋假日" : days.join("、") || "未選";
    $("citySummary").textContent = cities.length === 2 ? "雙北" : cities.map((city) => city.replace("市", "")).join("、") || "未選";
    $("districtSummary").textContent = districts.length === $("districtOptions").querySelectorAll("input").length ? "全部" : `${districts.length} 區`;
    $("gradeSummary").textContent = grades.join("") || "未選";
    $("metricSummary").textContent = selectedMetrics.length === 4 && DEFAULT_METRICS.every((metric) => selectedMetrics.includes(metric)) ? "4 項調度" : `${selectedMetrics.length} 項`;
    $("slotLabel").textContent = slotLabel(state.slot);
    $("selectionCopy").textContent = `${monthInfo.label} · ${dateItems.length} 個有效日期 · ${filtered.length} 站 · 地圖顯示 ${plotted} 站`;
    $("dateCount").textContent = fmt.format(dateItems.length);
    $("stationCount").textContent = fmt.format(filtered.length);
    $("rowCount").textContent = fmt.format(detailRows.length);
  }

  function refresh(resetPage = false) {
    if (!monthData || !dailyData) return;
    if (resetPage) state.page = 1;
    const dateItems = effectiveDateIndices();
    const filtered = filteredStationIndices();
    const selectedMetrics = checkedValues("metricOptions");
    const activity = buildActivity(dateItems);
    const rates = buildRates(dateItems);
    const { plotted, valuesByStation } = renderMap(filtered, dateItems, activity, rates, selectedMetrics);
    currentFilteredStations = filtered;
    currentDateMaps = activity.byDate;
    detailRows = buildDetailRows(filtered, dateItems, activity.byDate);
    renderDetail();
    renderLegend(selectedMetrics);
    renderKpis(filtered, selectedMetrics, valuesByStation);
    updateSummaries(dateItems, filtered, selectedMetrics, plotted);
  }

  function queueRefresh(resetPage = false) {
    if (resetPage) state.page = 1;
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      refresh(resetPage);
    });
  }

  function resetFilters() {
    setChecked("dateOptions", dailyData.dates.map((item) => item.date));
    setChecked("dayOptions", ["平日"]);
    setChecked("cityOptions", ["台北市", "新北市"]);
    buildDistricts(true);
    setChecked("gradeOptions", ["A", "B", "C"]);
    setChecked("metricOptions", DEFAULT_METRICS);
    $("usageThreshold").value = "100";
    $("stationSearch").value = "";
    state.query = "";
    state.slot = 16;
    $("slotRange").value = "16";
    queueRefresh(true);
  }

  function downloadCsv() {
    if (!detailRows.length) return toast("目前沒有可下載的明細");
    const header = ["日期", "星期", "平假日", "縣市", "行政區", "ABC級", "場站代碼", "場站名稱", "時段", "平日日均用量", ...ACTIVITY];
    const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [header.map(escapeCsv).join(",")];
    for (const row of detailRows) {
      const date = dailyData.dates[row[0]];
      const station = stations[row[1]];
      lines.push([date.date, date.weekday, date.dayType, station.city, station.district, station.grade, station.code, station.name, slotLabel(state.slot), station.usage, ...row.slice(2)].map(escapeCsv).join(","));
    }
    const blob = new Blob(["\ufeff", lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `友愛接力逐日明細_${state.month}_${slotStart(state.slot).replace(":", "")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast(`已匯出 ${fmt.format(detailRows.length)} 筆逐日明細`);
  }

  function closeMenus(except) {
    document.querySelectorAll("details.multi[open]").forEach((details) => { if (details !== except) details.removeAttribute("open"); });
  }

  function currentView() {
    return {
      month: state.month,
      slot: state.slot,
      slotLabel: slotLabel(state.slot),
      dates: checkedValues("dateOptions"),
      dayTypes: checkedValues("dayOptions"),
      cities: checkedValues("cityOptions"),
      districts: checkedValues("districtOptions"),
      grades: checkedValues("gradeOptions"),
      metrics: checkedValues("metricOptions"),
      usageThreshold: Number($("usageThreshold").value || 0),
      stationSearch: state.query,
      effectiveDateCount: effectiveDateIndices().length,
      filteredStationCount: currentFilteredStations.length
    };
  }

  function bindEvents() {
    $("monthSelect").addEventListener("change", (event) => loadMonth(event.target.value));
    $("slotRange").addEventListener("input", (event) => { state.slot = Number(event.target.value); queueRefresh(true); });
    $("usageThreshold").addEventListener("input", () => queueRefresh(true));
    $("stationSearch").addEventListener("input", (event) => { state.query = event.target.value; queueRefresh(true); });
    $("resetButton").addEventListener("click", resetFilters);
    $("downloadButton").addEventListener("click", downloadCsv);
    $("prevPage").addEventListener("click", () => { state.page -= 1; renderDetail(); });
    $("nextPage").addEventListener("click", () => { state.page += 1; renderDetail(); });

    $("playButton").addEventListener("click", () => {
      state.playing = !state.playing;
      $("playButton").classList.toggle("playing", state.playing);
      $("playButton").textContent = state.playing ? "■" : "▶";
      clearInterval(state.playTimer);
      if (state.playing) state.playTimer = setInterval(() => {
        state.slot = (state.slot + 1) % 48;
        $("slotRange").value = String(state.slot);
        queueRefresh(true);
      }, 1050);
    });

    document.querySelectorAll(".menu").forEach((menu) => menu.addEventListener("change", (event) => {
      if (event.target.closest("#cityOptions")) buildDistricts(true);
      queueRefresh(true);
    }));

    $("dateControl").addEventListener("click", (event) => {
      const action = event.target.dataset.dateAction;
      if (!action) return;
      const wanted = dailyData.dates.filter((item) => action === "all" || (action === "weekday" && item.dayType === "平日") || (action === "holiday" && item.dayType === "假日")).map((item) => item.date);
      setChecked("dateOptions", action === "none" ? [] : wanted);
      queueRefresh(true);
    });

    document.addEventListener("click", (event) => {
      const details = event.target.closest("details.multi");
      if (details) closeMenus(details);
      else closeMenus(null);
    });
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const reportError = (error) => console.warn("WebMCP registration failed", error);
    const register = (tool) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(reportError); }
      catch (error) { reportError(error); }
    };
    register({
      name: "read_heatmap_view",
      title: "讀取熱力圖篩選",
      description: "讀取目前友愛接力逐日熱力圖的月份、日期、城市、級別、指標與時段篩選。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => currentView()
    });
    register({
      name: "configure_heatmap_view",
      title: "設定熱力圖篩選",
      description: "批次設定友愛接力逐日熱力圖的月份、複選日期、平假日、城市、行政區、ABC級、指標、半小時時段與用量門檻，並更新畫面。",
      inputSchema: {
        type: "object",
        properties: {
          month: { type: "string" },
          dates: { type: "array", items: { type: "string" } },
          dayTypes: { type: "array", items: { type: "string", enum: ["平日", "假日"] } },
          cities: { type: "array", items: { type: "string", enum: ["台北市", "新北市"] } },
          districts: { type: "array", items: { type: "string" } },
          grades: { type: "array", items: { type: "string", enum: ["A", "B", "C"] } },
          metrics: { type: "array", items: { type: "string", enum: METRICS } },
          slot: { type: "integer", minimum: 0, maximum: 47 },
          usageThreshold: { type: "number", minimum: -1, maximum: 3000 },
          stationSearch: { type: "string" }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("輸入必須是物件");
        if (input.month && input.month !== state.month) {
          if (!MONTHS.months.some((item) => item.id === input.month)) throw new Error("不支援的月份");
          $("monthSelect").value = input.month;
          await loadMonth(input.month, true);
        }
        if (input.dates) setChecked("dateOptions", input.dates);
        if (input.dayTypes) setChecked("dayOptions", input.dayTypes);
        if (input.cities) { setChecked("cityOptions", input.cities); buildDistricts(true); }
        if (input.districts) setChecked("districtOptions", input.districts);
        if (input.grades) setChecked("gradeOptions", input.grades);
        if (input.metrics) setChecked("metricOptions", input.metrics);
        if (Number.isInteger(input.slot)) { state.slot = input.slot; $("slotRange").value = String(input.slot); }
        if (Number.isFinite(input.usageThreshold)) $("usageThreshold").value = String(input.usageThreshold);
        if (typeof input.stationSearch === "string") { state.query = input.stationSearch; $("stationSearch").value = input.stationSearch; }
        refresh(true);
        return currentView();
      }
    });
    window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  }

  async function init() {
    if (!MONTHS?.months?.length) {
      toast("找不到月份設定");
      hideLoading();
      return;
    }
    populateStaticControls();
    bindEvents();
    await loadMonth(state.month);
    registerWebMcp();
  }

  init();
})();
