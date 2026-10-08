(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const numberFormat = new Intl.NumberFormat("zh-TW");
  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];
  const PAGE_SIZE = 60;
  const CACHE_DAYS = 3;
  const COLORS = {
    route: "#52779a",
    routeFocus: "#102f4c",
    full: "#d9473f",
    empty: "#f19616",
    white: "#ffffff"
  };

  const state = {
    dateIndex: 0,
    page: 1,
    query: "",
    searchScope: "both",
    selectedRawIndex: null,
    loadToken: 0,
    refreshFrame: 0
  };

  let manifest = null;
  let manifestBase = "";
  let dates = [];
  let stations = [];
  let currentDay = null;
  let filteredEvents = [];
  let visibleRoutes = [];
  let visibleStations = [];
  let map = null;
  let flowLayer = null;
  let toastTimer = 0;
  let searchTimer = 0;
  let dayLoadQueue = Promise.resolve();
  const dayCache = new Map();
  const dayPromises = new Map();

  function safe(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function normalizedText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/臺/g, "台")
      .replace(/\s+/g, "")
      .toLocaleLowerCase("zh-Hant");
  }

  function normalizeCity(value) {
    const city = String(value ?? "").trim().replace(/臺/g, "台");
    if (city === "台北" || city === "臺北") return "台北市";
    if (city === "新北") return "新北市";
    return city;
  }

  function clampMinute(value) {
    const minute = Number(value);
    return Number.isFinite(minute) && minute >= 0 && minute < 1440 ? Math.floor(minute) : null;
  }

  function minuteLabel(minute) {
    if (!Number.isFinite(minute)) return "—";
    const normalized = Math.max(0, Math.min(1439, Math.floor(minute)));
    return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
  }

  function parseTime(value, fallback) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
    return hour * 60 + minute;
  }

  function dateKey(value) {
    if (typeof value === "string") return value.slice(0, 10);
    if (Array.isArray(value)) return String(value[0] ?? "").slice(0, 10);
    if (value && typeof value === "object") return String(value.date ?? value.id ?? value.value ?? "").slice(0, 10);
    return "";
  }

  function dateLabel(key, raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.label) return String(raw.label);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return key || "未知日期";
    const localDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const weekday = Number.isNaN(localDate.getTime()) ? "" : `（週${weekdayNames[localDate.getDay()]}）`;
    return `${Number(match[2])} 月 ${Number(match[3])} 日${weekday}`;
  }

  function fullDateLabel(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!match) return key || "—";
    return `${match[1]}/${match[2]}/${match[3]}`;
  }

  function durationLabel(borrowMinute, returnMinute) {
    if (!Number.isFinite(borrowMinute) || !Number.isFinite(returnMinute)) return "時間不完整";
    let duration = returnMinute - borrowMinute;
    if (duration < 0) duration += 1440;
    if (duration < 60) return `${duration} 分`;
    const hours = Math.floor(duration / 60);
    const minutes = duration % 60;
    return minutes ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  }

  function timeInRange(minute, start, end) {
    if (!Number.isFinite(minute)) return false;
    return start <= end ? minute >= start && minute <= end : minute >= start || minute <= end;
  }

  function toast(message) {
    window.clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.add("show");
    toastTimer = window.setTimeout(() => $("toast").classList.remove("show"), 2600);
  }

  function setInitialLoading(title, detail) {
    $("loadingTitle").textContent = title;
    $("loadingDetail").textContent = detail;
  }

  function hideInitialLoading() {
    $("appLoading").classList.add("fade-out");
    window.setTimeout(() => $("appLoading").classList.add("hidden"), 230);
  }

  function setMapBusy(busy, text = "載入單日事件…") {
    $("mapBusy").classList.toggle("hidden", !busy);
    const label = $("mapBusy").querySelector("b");
    if (label) label.textContent = text;
  }

  function setMapMessage(message = "", title = "") {
    const node = $("mapMessage");
    if (!message) {
      node.classList.add("hidden");
      node.textContent = "";
      return;
    }
    node.innerHTML = `${title ? `<strong>${safe(title)}</strong>` : ""}${safe(message)}`;
    node.classList.remove("hidden");
  }

  function injectScript(src, kind) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.dataset.relayData = kind;
      script.onload = () => resolve(script);
      script.onerror = () => {
        script.remove();
        reject(new Error(`無法載入 ${src}`));
      };
      document.head.appendChild(script);
    });
  }

  function sourceDirectory(src) {
    const clean = String(src || "").split(/[?#]/)[0];
    const slash = clean.lastIndexOf("/");
    return slash >= 0 ? clean.slice(0, slash + 1) : "";
  }

  async function loadManifest() {
    if (window.FRIENDLY_RELAY_OD_MANIFEST) return window.FRIENDLY_RELAY_OD_MANIFEST;

    const parameter = new URLSearchParams(window.location.search).get("manifest");
    const candidates = [parameter, "data/manifest.js", "manifest.js"].filter(Boolean);
    let lastError = null;
    for (const src of [...new Set(candidates)]) {
      try {
        const script = await injectScript(src, "manifest");
        const loaded = window.FRIENDLY_RELAY_OD_MANIFEST;
        if (loaded) {
          manifestBase = sourceDirectory(src);
          script.dataset.loaded = "true";
          return loaded;
        }
        script.remove();
        lastError = new Error(`${src} 未設定 FRIENDLY_RELAY_OD_MANIFEST`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("找不到資料 manifest");
  }

  function dayFileValue(index, key) {
    const files = manifest?.dayFiles;
    if (Array.isArray(files)) {
      let entry = files[index];
      if (Array.isArray(entry)) {
        if (String(entry[0]) === key) return entry[1];
        const matched = files.find((item) => Array.isArray(item) && String(item[0]) === key);
        entry = matched || entry;
      } else if (entry && typeof entry === "object" && entry.date && String(entry.date) !== key) {
        entry = files.find((item) => item && typeof item === "object" && String(item.date) === key) || entry;
      }
      if (Array.isArray(entry)) return entry[1];
      if (entry && typeof entry === "object") return entry.src ?? entry.file ?? entry.path;
      return entry;
    }
    if (files && typeof files === "object") {
      const entry = files[key] ?? files[index] ?? files[String(index)];
      if (entry && typeof entry === "object") return entry.src ?? entry.file ?? entry.path;
      return entry;
    }
    const dateEntry = manifest?.dates?.[index];
    if (Array.isArray(dateEntry)) return dateEntry[2];
    if (dateEntry && typeof dateEntry === "object") return dateEntry.src ?? dateEntry.file ?? dateEntry.path;
    return null;
  }

  function dayFileCandidates(index, key) {
    const file = String(dayFileValue(index, key) ?? "").trim();
    if (!file) return [];
    const candidates = [file];
    const absolute = /^(?:[a-z]+:)?\/\//i.test(file) || file.startsWith("/") || file.startsWith("./") || file.startsWith("../");
    if (!absolute && manifestBase && !file.startsWith(manifestBase)) {
      const based = `${manifestBase}${file}`;
      if (file.includes("/")) candidates.push(based);
      else candidates.unshift(based);
    }
    return [...new Set(candidates)];
  }

  function cacheDay(key, payload) {
    if (dayCache.has(key)) dayCache.delete(key);
    dayCache.set(key, payload);
    while (dayCache.size > CACHE_DAYS) {
      const oldest = dayCache.keys().next().value;
      dayCache.delete(oldest);
    }
  }

  function actuallyLoadDay(index, key) {
    const candidates = dayFileCandidates(index, key);
    if (!candidates.length) return Promise.reject(new Error(`${key} 沒有對應的每日資料檔`));

    return (async () => {
      let lastError = null;
      for (const src of candidates) {
        try {
          window.FRIENDLY_RELAY_OD_DAY = undefined;
          const script = await injectScript(src, "day");
          const payload = window.FRIENDLY_RELAY_OD_DAY;
          window.FRIENDLY_RELAY_OD_DAY = undefined;
          script.remove();
          if (!payload || !Array.isArray(payload.events)) throw new Error(`${src} 的每日資料格式錯誤`);
          const payloadDate = dateKey(payload.date);
          if (payloadDate && payloadDate !== key) throw new Error(`${src} 日期為 ${payloadDate}，預期 ${key}`);
          cacheDay(key, payload);
          return payload;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error(`無法載入 ${key} 每日資料`);
    })();
  }

  function loadDay(index) {
    const key = dates[index]?.key;
    if (!key) return Promise.reject(new Error("日期索引無效"));
    if (dayCache.has(key)) {
      const cached = dayCache.get(key);
      dayCache.delete(key);
      dayCache.set(key, cached);
      return Promise.resolve(cached);
    }
    if (dayPromises.has(key)) return dayPromises.get(key);

    const queued = dayLoadQueue.then(() => actuallyLoadDay(index, key));
    dayLoadQueue = queued.catch(() => undefined);
    dayPromises.set(key, queued);
    return queued.finally(() => dayPromises.delete(key));
  }

  function normalizeStations(rows) {
    return rows.map((row, index) => {
      const name = String(row?.[0] ?? `場站 ${index + 1}`);
      const city = normalizeCity(row?.[1]);
      const district = String(row?.[2] ?? "");
      const rawLat = row?.[3];
      const rawLon = row?.[4];
      const lat = rawLat == null || rawLat === "" ? NaN : Number(rawLat);
      const lon = rawLon == null || rawLon === "" ? NaN : Number(rawLon);
      const code = String(row?.[5] ?? "");
      return {
        index,
        name,
        city,
        district,
        lat,
        lon,
        code,
        validCoordinate: Number.isFinite(lat) && Number.isFinite(lon)
          && lat >= 24.3 && lat <= 25.7 && lon >= 120.7 && lon <= 122.3,
        search: normalizedText(`${name} ${code} ${city} ${district}`)
      };
    });
  }

  function buildManifestUI() {
    const meta = manifest.meta || {};
    const title = meta.title || meta.name || "九月友愛接力起訖地圖";
    const subtitle = meta.subtitle || meta.description || "以獎勵發生時間呈現滿借與空還訂單流向";
    document.title = title;
    $("pageTitle").textContent = title;
    $("pageSubtitle").textContent = subtitle;

    const updated = meta.generatedAt || meta.updatedAt || meta.generated || meta.version || "";
    $("updatedCopy").textContent = updated ? `資料版本 ${String(updated).replace("T", " ").slice(0, 16)}` : `${dates.length} 個每日資料檔`;

    $("dateSelect").innerHTML = dates.map((date, index) => `<option value="${index}">${safe(date.label)}</option>`).join("");
    const defaultKey = dateKey(meta.defaultDate);
    const requestedIndex = Number(meta.defaultDateIndex);
    if (defaultKey && dates.some((date) => date.key === defaultKey)) {
      state.dateIndex = dates.findIndex((date) => date.key === defaultKey);
    } else if (Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < dates.length) {
      state.dateIndex = requestedIndex;
    } else {
      state.dateIndex = dates.length - 1;
    }
    $("dateSelect").value = String(state.dateIndex);
    syncDateButtons();
  }

  function syncDateButtons() {
    $("previousDate").disabled = state.dateIndex <= 0;
    $("nextDate").disabled = state.dateIndex >= dates.length - 1;
    $("dateSelect").value = String(state.dateIndex);
    $("selectionDate").textContent = fullDateLabel(dates[state.dateIndex]?.key);
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function pointSegmentDistance(point, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    const position = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
    const x = start.x + position * dx;
    const y = start.y + position * dy;
    return Math.hypot(point.x - x, point.y - y);
  }

  function createFlowLayerClass() {
    return L.Layer.extend({
      initialize() {
        this._routes = [];
        this._stations = [];
        this._focus = null;
        this._frame = 0;
      },

      onAdd(activeMap) {
        this._map = activeMap;
        this._canvas = L.DomUtil.create("canvas", "relay-flow-canvas leaflet-zoom-hide");
        this._canvas.style.position = "absolute";
        this._canvas.style.pointerEvents = "none";
        this._canvas.style.zIndex = "350";
        activeMap.getPane("overlayPane").appendChild(this._canvas);
        activeMap.on("moveend zoomend resize viewreset", this._schedule, this);
        this._schedule();
      },

      onRemove(activeMap) {
        activeMap.off("moveend zoomend resize viewreset", this._schedule, this);
        window.cancelAnimationFrame(this._frame);
        this._canvas?.remove();
      },

      setData(routes, stationRows) {
        this._routes = routes || [];
        this._stations = stationRows || [];
        this._schedule();
      },

      setFocus(event) {
        this._focus = event || null;
        this._schedule();
      },

      _schedule() {
        window.cancelAnimationFrame(this._frame);
        this._frame = window.requestAnimationFrame(() => this._draw());
      },

      _routeWidth(count) {
        return Math.min(8, 0.8 + Math.log2(Math.max(1, count) + 1) * 0.92);
      },

      _routePath(ctx, route) {
        const start = route._start;
        const end = route._end;
        if (!start || !end) return;
        if (Math.hypot(end.x - start.x, end.y - start.y) < 3) {
          ctx.moveTo(start.x + 10, start.y);
          ctx.arc(start.x, start.y, 10, 0, Math.PI * 2);
        } else {
          ctx.moveTo(start.x, start.y);
          ctx.lineTo(end.x, end.y);
        }
      },

      _draw() {
        if (!this._map || !this._canvas) return;
        const size = this._map.getSize();
        const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const topLeft = this._map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(this._canvas, topLeft);
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
        this._canvas.width = Math.max(1, Math.floor(size.x * ratio));
        this._canvas.height = Math.max(1, Math.floor(size.y * ratio));
        const ctx = this._canvas.getContext("2d");
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, size.x, size.y);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        const buckets = new Map();
        for (const route of this._routes) {
          route._start = this._map.latLngToContainerPoint([route.origin.lat, route.origin.lon]);
          route._end = this._map.latLngToContainerPoint([route.destination.lat, route.destination.lon]);
          const width = Math.round(this._routeWidth(route.orders) * 2) / 2;
          if (!buckets.has(width)) buckets.set(width, []);
          buckets.get(width).push(route);
        }

        ctx.strokeStyle = COLORS.route;
        ctx.globalAlpha = this._routes.length > 5000 ? 0.24 : this._routes.length > 1500 ? 0.3 : 0.38;
        for (const [width, routes] of buckets) {
          ctx.lineWidth = width;
          ctx.beginPath();
          for (const route of routes) this._routePath(ctx, route);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;

        if (this._map.getZoom() >= 11) this._drawRouteLabels(ctx);
        for (const stationRow of this._stations) this._drawStation(ctx, stationRow);
        if (this._focus) this._drawFocus(ctx, this._focus);
      },

      _drawRouteLabels(ctx) {
        const occupied = new Set();
        let drawn = 0;
        ctx.font = "700 9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const route of this._routes) {
          if (route.orders < 2 || drawn >= 16 || !route._start || !route._end) continue;
          const x = (route._start.x + route._end.x) / 2;
          const y = (route._start.y + route._end.y) / 2;
          const cell = `${Math.round(x / 48)}:${Math.round(y / 24)}`;
          if (occupied.has(cell)) continue;
          occupied.add(cell);
          const text = `×${numberFormat.format(route.orders)}`;
          const width = Math.ceil(ctx.measureText(text).width) + 10;
          roundedRect(ctx, x - width / 2, y - 9, width, 18, 7);
          ctx.fillStyle = "rgba(255,255,255,.92)";
          ctx.fill();
          ctx.strokeStyle = "rgba(82,119,154,.55)";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = "#365c7e";
          ctx.fillText(text, x, y + 0.5);
          drawn += 1;
        }
      },

      _drawStation(ctx, row) {
        const point = this._map.latLngToContainerPoint([row.station.lat, row.station.lon]);
        const maximum = Math.max(row.full, row.empty);
        const radius = Math.min(15, 5 + Math.sqrt(Math.max(1, maximum)) * 0.9);
        row._point = point;
        row._radius = radius;

        if (row.full && row.empty) {
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - radius);
          ctx.arc(point.x, point.y, radius, -Math.PI / 2, Math.PI / 2, true);
          ctx.closePath();
          ctx.fillStyle = COLORS.full;
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(point.x, point.y - radius);
          ctx.arc(point.x, point.y, radius, -Math.PI / 2, Math.PI / 2, false);
          ctx.closePath();
          ctx.fillStyle = COLORS.empty;
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
          ctx.fillStyle = row.full ? COLORS.full : COLORS.empty;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,255,255,.96)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius + 1, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(20,40,58,.28)";
        ctx.lineWidth = 1;
        ctx.stroke();
      },

      _drawFocus(ctx, event) {
        const origin = stations[event.originIndex];
        const destination = stations[event.destinationIndex];
        if (!origin?.validCoordinate || !destination?.validCoordinate) return;
        const start = this._map.latLngToContainerPoint([origin.lat, origin.lon]);
        const end = this._map.latLngToContainerPoint([destination.lat, destination.lon]);
        const distance = Math.hypot(end.x - start.x, end.y - start.y);

        ctx.globalAlpha = 1;
        ctx.strokeStyle = "rgba(255,255,255,.95)";
        ctx.lineWidth = 7;
        ctx.beginPath();
        if (distance < 3) ctx.arc(start.x, start.y, 17, 0, Math.PI * 2);
        else { ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); }
        ctx.stroke();
        ctx.strokeStyle = COLORS.routeFocus;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        if (distance < 3) ctx.arc(start.x, start.y, 17, 0, Math.PI * 2);
        else { ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); }
        ctx.stroke();

        if (distance >= 12) {
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const x = start.x + (end.x - start.x) * 0.72;
          const y = start.y + (end.y - start.y) * 0.72;
          ctx.beginPath();
          ctx.moveTo(x + Math.cos(angle) * 6, y + Math.sin(angle) * 6);
          ctx.lineTo(x + Math.cos(angle + 2.48) * 7, y + Math.sin(angle + 2.48) * 7);
          ctx.lineTo(x + Math.cos(angle - 2.48) * 7, y + Math.sin(angle - 2.48) * 7);
          ctx.closePath();
          ctx.fillStyle = COLORS.routeFocus;
          ctx.fill();
        }

        if (event.visibleFlags & 1) this._drawFocusPoint(ctx, start, COLORS.full);
        if (event.visibleFlags & 2) this._drawFocusPoint(ctx, end, COLORS.empty);
      },

      _drawFocusPoint(ctx, point, color) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = COLORS.white;
        ctx.lineWidth = 3;
        ctx.stroke();
      },

      hitTest(containerPoint) {
        let bestStation = null;
        let bestDistance = Infinity;
        for (const stationRow of this._stations) {
          if (!stationRow._point) continue;
          const distance = Math.hypot(containerPoint.x - stationRow._point.x, containerPoint.y - stationRow._point.y);
          if (distance <= stationRow._radius + 5 && distance < bestDistance) {
            bestDistance = distance;
            bestStation = stationRow;
          }
        }
        if (bestStation) return { type: "station", value: bestStation };

        let bestRoute = null;
        bestDistance = Infinity;
        for (const route of this._routes) {
          if (!route._start || !route._end) continue;
          let distance;
          if (Math.hypot(route._end.x - route._start.x, route._end.y - route._start.y) < 3) {
            distance = Math.abs(Math.hypot(containerPoint.x - route._start.x, containerPoint.y - route._start.y) - 10);
          } else {
            distance = pointSegmentDistance(containerPoint, route._start, route._end);
          }
          const tolerance = Math.max(7, this._routeWidth(route.orders) + 4);
          if (distance <= tolerance && distance < bestDistance) {
            bestDistance = distance;
            bestRoute = route;
          }
        }
        return bestRoute ? { type: "route", value: bestRoute } : null;
      }
    });
  }

  function initializeMap() {
    if (!window.L) throw new Error("Leaflet 載入失敗，請確認網路連線後重新整理");
    map = L.map("map", {
      preferCanvas: true,
      zoomControl: true,
      minZoom: 8,
      maxZoom: 19
    }).setView([25.0478, 121.5447], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);
    const FlowLayer = createFlowLayerClass();
    flowLayer = new FlowLayer().addTo(map);
    map.on("click", handleMapClick);
  }

  function selectedCities() {
    return new Set([...$("cityOptions").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value));
  }

  function eventMatchesQuery(origin, destination, query, scope) {
    if (!query) return true;
    if (scope === "origin") return origin.search.includes(query);
    if (scope === "destination") return destination.search.includes(query);
    return origin.search.includes(query) || destination.search.includes(query);
  }

  function addStationAward(awards, stationIndex, type) {
    const current = awards.get(stationIndex) || { station: stations[stationIndex], full: 0, empty: 0 };
    current[type] += 1;
    awards.set(stationIndex, current);
  }

  function filterCurrentDay() {
    const rows = Array.isArray(currentDay?.events) ? currentDay.events : [];
    const cities = selectedCities();
    const start = parseTime($("timeStart").value, 0);
    const end = parseTime($("timeEnd").value, 1439);
    const query = normalizedText(state.query);
    const scope = state.searchScope;
    const result = [];
    const routeMap = new Map();
    const stationAwards = new Map();
    let invalid = 0;
    let fullTotal = 0;
    let emptyTotal = 0;

    for (let rawIndex = 0; rawIndex < rows.length; rawIndex += 1) {
      const row = rows[rawIndex];
      if (!Array.isArray(row) || row.length < 5) { invalid += 1; continue; }
      const borrowMinute = clampMinute(row[0]);
      const returnMinute = clampMinute(row[1]);
      const originIndex = Number(row[2]);
      const destinationIndex = Number(row[3]);
      const flags = Number(row[4]) & 3;
      const origin = stations[originIndex];
      const destination = stations[destinationIndex];
      if (!origin || !destination || !flags) { invalid += 1; continue; }

      const fullMatch = Boolean(flags & 1) && timeInRange(borrowMinute, start, end) && cities.has(origin.city);
      const emptyMatch = Boolean(flags & 2) && timeInRange(returnMinute, start, end) && cities.has(destination.city);
      let visibleFlags = 0;
      if (fullMatch) visibleFlags |= 1;
      if (emptyMatch) visibleFlags |= 2;
      if (!visibleFlags || !eventMatchesQuery(origin, destination, query, scope)) continue;

      const rewardMinute = visibleFlags === 3 ? Math.min(borrowMinute, returnMinute) : visibleFlags === 1 ? borrowMinute : returnMinute;
      const event = { rawIndex, borrowMinute, returnMinute, originIndex, destinationIndex, flags, visibleFlags, rewardMinute };
      result.push(event);

      const routeKey = `${originIndex}:${destinationIndex}`;
      const route = routeMap.get(routeKey) || {
        key: routeKey,
        origin,
        destination,
        orders: 0,
        full: 0,
        empty: 0
      };
      route.orders += 1;
      if (visibleFlags & 1) {
        route.full += 1;
        fullTotal += 1;
        addStationAward(stationAwards, originIndex, "full");
      }
      if (visibleFlags & 2) {
        route.empty += 1;
        emptyTotal += 1;
        addStationAward(stationAwards, destinationIndex, "empty");
      }
      routeMap.set(routeKey, route);
    }

    result.sort((a, b) => a.rewardMinute - b.rewardMinute || a.borrowMinute - b.borrowMinute || a.rawIndex - b.rawIndex);
    filteredEvents = result;
    visibleRoutes = [...routeMap.values()]
      .filter((route) => route.origin.validCoordinate && route.destination.validCoordinate)
      .sort((a, b) => b.orders - a.orders || b.full - a.full || a.key.localeCompare(b.key));
    visibleStations = [...stationAwards.values()]
      .filter((row) => row.station?.validCoordinate)
      .sort((a, b) => Math.max(b.full, b.empty) - Math.max(a.full, a.empty));

    return { start, end, invalid, fullTotal, emptyTotal, orderTotal: result.length, routeTotal: routeMap.size };
  }

  function timeWindowLabel(start, end) {
    return start <= end
      ? `${minuteLabel(start)}–${minuteLabel(end)}`
      : `${minuteLabel(start)}–翌日 ${minuteLabel(end)}`;
  }

  function citySelectionLabel() {
    const cities = [...selectedCities()];
    if (cities.length === 2) return "雙北獎勵站";
    if (cities.length === 1) return `${cities[0]}獎勵站`;
    return "未選縣市";
  }

  function updateSummary(summary) {
    $("orderCount").textContent = numberFormat.format(summary.orderTotal);
    $("fullCount").textContent = numberFormat.format(summary.fullTotal);
    $("emptyCount").textContent = numberFormat.format(summary.emptyTotal);
    $("routeCount").textContent = numberFormat.format(summary.routeTotal);
    $("listTotal").textContent = numberFormat.format(summary.orderTotal);

    const queryText = state.query.trim() ? ` · 搜尋「${state.query.trim()}」` : "";
    $("selectionCopy").textContent = `${citySelectionLabel()} · 獎勵時間 ${timeWindowLabel(summary.start, summary.end)} · ${numberFormat.format(summary.orderTotal)} 筆訂單${queryText}`;
    $("selectionHint").textContent = summary.invalid
      ? `略過 ${numberFormat.format(summary.invalid)} 筆格式不完整資料；縣市依獎勵站判斷。`
      : "縣市依獎勵站判斷；跨午夜時段可直接選擇。";
  }

  function renderEventList() {
    const pages = Math.max(1, Math.ceil(filteredEvents.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const startIndex = (state.page - 1) * PAGE_SIZE;
    const pageRows = filteredEvents.slice(startIndex, startIndex + PAGE_SIZE);

    if (!pageRows.length) {
      $("eventList").innerHTML = '<div class="list-empty"><div><strong>沒有符合條件的訂單</strong>可放寬時間、縣市或場站搜尋條件。</div></div>';
    } else {
      $("eventList").innerHTML = pageRows.map((event, offset) => {
        const index = startIndex + offset;
        const origin = stations[event.originIndex];
        const destination = stations[event.destinationIndex];
        const fullBadge = event.visibleFlags & 1
          ? `<span class="award-badge full"><i></i>滿借 ${minuteLabel(event.borrowMinute)}</span>`
          : "";
        const emptyBadge = event.visibleFlags & 2
          ? `<span class="award-badge empty"><i></i>空還 ${minuteLabel(event.returnMinute)}</span>`
          : "";
        const returnSuffix = Number.isFinite(event.returnMinute) && Number.isFinite(event.borrowMinute) && event.returnMinute < event.borrowMinute ? " 翌日" : "";
        const active = state.selectedRawIndex === event.rawIndex ? " active" : "";
        const originCode = origin.code ? `<small>${safe(origin.code)}</small>` : "";
        const destinationCode = destination.code ? `<small>${safe(destination.code)}</small>` : "";
        const aria = `${event.visibleFlags & 1 ? "滿借獎勵" : ""}${event.visibleFlags === 3 ? "、" : ""}${event.visibleFlags & 2 ? "空還獎勵" : ""}，${origin.name} 到 ${destination.name}`;
        return `<button class="event-row${active}" type="button" data-event-index="${index}" aria-label="${safe(aria)}">
          <span class="event-awards">${fullBadge}${emptyBadge}<span class="event-times"><b>借</b> ${minuteLabel(event.borrowMinute)}　<b>還</b> ${minuteLabel(event.returnMinute)}${returnSuffix}<br>${safe(durationLabel(event.borrowMinute, event.returnMinute))}</span></span>
          <span class="event-route">
            <span class="route-place ${event.visibleFlags & 1 ? "reward-full" : ""}"><i class="place-dot"></i><strong>${safe(origin.name)}${originCode}</strong></span>
            <span class="route-place ${event.visibleFlags & 2 ? "reward-empty" : ""}"><i class="place-dot"></i><strong>${safe(destination.name)}${destinationCode}</strong></span>
          </span>
        </button>`;
      }).join("");
    }

    $("pageCopy").textContent = `第 ${numberFormat.format(state.page)} / ${numberFormat.format(pages)} 頁`;
    $("previousPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
    $("eventList").scrollTop = 0;
  }

  function fitVisibleRoutes() {
    if (!map || !visibleRoutes.length) return;
    const coordinates = [];
    for (const route of visibleRoutes) {
      coordinates.push([route.origin.lat, route.origin.lon], [route.destination.lat, route.destination.lon]);
    }
    if (!coordinates.length) return;
    const bounds = L.latLngBounds(coordinates);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 14, animate: false });
  }

  function applyFilters(options = {}) {
    window.cancelAnimationFrame(state.refreshFrame);
    state.refreshFrame = window.requestAnimationFrame(() => {
      state.page = options.keepPage ? state.page : 1;
      const summary = filterCurrentDay();
      updateSummary(summary);
      renderEventList();
      flowLayer?.setData(visibleRoutes, visibleStations);
      if (!filteredEvents.some((event) => event.rawIndex === state.selectedRawIndex)) {
        state.selectedRawIndex = null;
        flowLayer?.setFocus(null);
      }
      if (!summary.orderTotal) setMapMessage("目前沒有符合條件的訂單，請調整時間、縣市或搜尋場站。", "沒有篩選結果");
      else setMapMessage();
      if (options.fit) fitVisibleRoutes();
    });
  }

  function stationPopup(row) {
    const station = row.station;
    const place = [station.city, station.district, station.code].filter(Boolean).join(" · ");
    return `<div class="relay-popup"><h3>${safe(station.name)}<span class="popup-place">${safe(place)}</span></h3><dl><dt>滿借獎勵（起點）</dt><dd class="full">${numberFormat.format(row.full)} 筆</dd><dt>空還獎勵（終點）</dt><dd class="empty">${numberFormat.format(row.empty)} 筆</dd><dt>獎勵合計</dt><dd>${numberFormat.format(row.full + row.empty)} 次</dd></dl></div>`;
  }

  function routePopup(route) {
    return `<div class="relay-popup"><h3>相同 OD 路線<span class="popup-place">${safe(route.origin.city)}／${safe(route.destination.city)}</span></h3><div class="popup-route"><i class="full"></i><span><b>${safe(route.origin.name)}</b><br>起點</span></div><div class="popup-route"><i class="empty"></i><span><b>${safe(route.destination.name)}</b><br>終點</span></div><dl><dt>訂單筆數</dt><dd>${numberFormat.format(route.orders)} 筆</dd><dt>符合滿借獎勵</dt><dd class="full">${numberFormat.format(route.full)} 次</dd><dt>符合空還獎勵</dt><dd class="empty">${numberFormat.format(route.empty)} 次</dd></dl><p class="popup-note">同一訂單可能同時包含兩種獎勵，因此獎勵次數可大於訂單筆數。</p></div>`;
  }

  function eventPopup(event) {
    const origin = stations[event.originIndex];
    const destination = stations[event.destinationIndex];
    const awards = [
      event.visibleFlags & 1 ? `滿借 ${minuteLabel(event.borrowMinute)}` : "",
      event.visibleFlags & 2 ? `空還 ${minuteLabel(event.returnMinute)}` : ""
    ].filter(Boolean).join("、");
    return `<div class="relay-popup"><h3>友愛接力訂單<span class="popup-place">${safe(fullDateLabel(dates[state.dateIndex]?.key))}</span></h3><div class="popup-route"><i class="full"></i><span><b>${safe(origin.name)}</b><br>借車 ${minuteLabel(event.borrowMinute)}</span></div><div class="popup-route"><i class="empty"></i><span><b>${safe(destination.name)}</b><br>還車 ${minuteLabel(event.returnMinute)}</span></div><dl><dt>符合的獎勵</dt><dd>${safe(awards)}</dd><dt>騎乘時間</dt><dd>${safe(durationLabel(event.borrowMinute, event.returnMinute))}</dd></dl></div>`;
  }

  function handleMapClick(event) {
    const hit = flowLayer?.hitTest(event.containerPoint);
    if (!hit) return;
    if (hit.type === "station") {
      L.popup({ maxWidth: 300, closeButton: true }).setLatLng(event.latlng).setContent(stationPopup(hit.value)).openOn(map);
    } else if (hit.type === "route") {
      L.popup({ maxWidth: 300, closeButton: true }).setLatLng(event.latlng).setContent(routePopup(hit.value)).openOn(map);
    }
  }

  function focusEvent(event) {
    if (!event) return;
    state.selectedRawIndex = event.rawIndex;
    flowLayer?.setFocus(event);
    $("eventList").querySelectorAll(".event-row").forEach((row) => {
      const rowEvent = filteredEvents[Number(row.dataset.eventIndex)];
      row.classList.toggle("active", rowEvent?.rawIndex === event.rawIndex);
    });

    const origin = stations[event.originIndex];
    const destination = stations[event.destinationIndex];
    if (!map || !origin?.validCoordinate || !destination?.validCoordinate) return;
    const bounds = L.latLngBounds([[origin.lat, origin.lon], [destination.lat, destination.lon]]);
    if (origin.lat === destination.lat && origin.lon === destination.lon) map.setView([origin.lat, origin.lon], Math.max(15, map.getZoom()), { animate: true });
    else map.fitBounds(bounds, { padding: [70, 70], maxZoom: 15, animate: true });
    const midpoint = [(origin.lat + destination.lat) / 2, (origin.lon + destination.lon) / 2];
    window.setTimeout(() => L.popup({ maxWidth: 300 }).setLatLng(midpoint).setContent(eventPopup(event)).openOn(map), 210);
  }

  async function selectDate(index, options = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= dates.length) return;
    state.dateIndex = index;
    state.page = 1;
    state.selectedRawIndex = null;
    syncDateButtons();
    const token = ++state.loadToken;
    setMapBusy(true, `載入 ${dates[index].label}…`);
    setMapMessage();
    flowLayer?.setFocus(null);

    try {
      const payload = await loadDay(index);
      if (token !== state.loadToken) return;
      currentDay = payload;
      applyFilters({ fit: options.fit !== false });
    } catch (error) {
      if (token !== state.loadToken) return;
      console.error(error);
      currentDay = { date: dates[index].key, events: [] };
      applyFilters();
      setMapMessage(error.message, "每日資料載入失敗");
      toast(`載入失敗：${error.message}`);
    } finally {
      if (token === state.loadToken) setMapBusy(false);
    }
  }

  function resetFilters() {
    $("cityOptions").querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = true; });
    $("timeStart").value = "00:00";
    $("timeEnd").value = "23:59";
    $("stationSearch").value = "";
    $("searchScope").value = "both";
    $("clearSearch").classList.add("hidden");
    state.query = "";
    state.searchScope = "both";
    state.selectedRawIndex = null;
    applyFilters({ fit: true });
  }

  function bindControls() {
    $("dateSelect").addEventListener("change", (event) => selectDate(Number(event.target.value), { fit: true }));
    $("previousDate").addEventListener("click", () => selectDate(state.dateIndex - 1, { fit: true }));
    $("nextDate").addEventListener("click", () => selectDate(state.dateIndex + 1, { fit: true }));
    $("cityOptions").addEventListener("change", () => applyFilters({ fit: true }));
    $("timeStart").addEventListener("change", () => applyFilters());
    $("timeEnd").addEventListener("change", () => applyFilters());
    $("searchScope").addEventListener("change", (event) => {
      state.searchScope = event.target.value;
      applyFilters({ fit: Boolean(state.query.trim()) });
    });
    $("stationSearch").addEventListener("input", (event) => {
      const value = event.target.value;
      $("clearSearch").classList.toggle("hidden", !value);
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.query = value;
        applyFilters({ fit: Boolean(value.trim()) });
      }, 180);
    });
    $("clearSearch").addEventListener("click", () => {
      $("stationSearch").value = "";
      $("clearSearch").classList.add("hidden");
      state.query = "";
      applyFilters();
      $("stationSearch").focus();
    });
    $("resetFilters").addEventListener("click", resetFilters);
    $("previousPage").addEventListener("click", () => {
      if (state.page <= 1) return;
      state.page -= 1;
      renderEventList();
    });
    $("nextPage").addEventListener("click", () => {
      if (state.page >= Math.ceil(filteredEvents.length / PAGE_SIZE)) return;
      state.page += 1;
      renderEventList();
    });
    $("eventList").addEventListener("click", (event) => {
      const row = event.target.closest(".event-row");
      if (!row) return;
      focusEvent(filteredEvents[Number(row.dataset.eventIndex)]);
    });
    window.addEventListener("resize", () => map?.invalidateSize({ pan: false }));
  }

  function showFatal(error) {
    console.error(error);
    setMapMessage(
      "請確認 data/manifest.js（或 manifest.js）已設定 FRIENDLY_RELAY_OD_MANIFEST，且網路可載入 Leaflet。",
      error.message || "前端初始化失敗"
    );
    $("eventList").innerHTML = '<div class="list-empty"><div><strong>資料尚未就緒</strong>完成 manifest 與每日 shard 後即可使用。</div></div>';
    $("dateSelect").disabled = true;
    $("previousDate").disabled = true;
    $("nextDate").disabled = true;
  }

  async function start() {
    try {
      setInitialLoading("準備地圖", "正在啟動 Leaflet…");
      initializeMap();
      bindControls();
      setInitialLoading("讀取資料索引", "載入日期、場站與每日檔案清單…");
      manifest = await loadManifest();
      if (!manifest || !Array.isArray(manifest.dates) || !Array.isArray(manifest.stations)) {
        throw new Error("FRIENDLY_RELAY_OD_MANIFEST 格式不完整");
      }
      dates = manifest.dates.map((raw, index) => {
        const key = dateKey(raw);
        return { index, key, label: dateLabel(key, raw), raw };
      });
      if (!dates.length || dates.some((date) => !date.key)) throw new Error("manifest 未提供有效日期");
      stations = normalizeStations(manifest.stations);
      buildManifestUI();
      setInitialLoading("載入單日事件", dates[state.dateIndex].label);
      await selectDate(state.dateIndex, { fit: true });
    } catch (error) {
      showFatal(error);
    } finally {
      hideInitialLoading();
      window.setTimeout(() => map?.invalidateSize({ pan: false }), 50);
    }
  }

  window.FriendlyRelayODApp = {
    refresh: () => applyFilters(),
    selectDate: (index) => selectDate(Number(index), { fit: true }),
    getState: () => ({
      date: dates[state.dateIndex]?.key || null,
      orders: filteredEvents.length,
      routes: visibleRoutes.length,
      cachedDays: [...dayCache.keys()]
    })
  };

  start();
})();
