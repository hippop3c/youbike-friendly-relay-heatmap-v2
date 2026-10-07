from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


OUTPUT_PREFIX = "window.YOUBIKE_CARD_DAILY="


def parse_datetime(value: str) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def normalize_card(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    return re.sub(r"[\s\-]+", "", text)


def normalize_city(value: str) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().replace("臺", "台")


def card_suffix(value: str) -> str | None:
    normalized = normalize_card(value)
    return normalized[-5:] if len(normalized) >= 5 else None


def month_configs(source_root: Path) -> dict[str, dict[str, Any]]:
    return {
        "2026-07": {
            "start": dt.date(2026, 7, 1),
            "end": dt.date(2026, 7, 31),
            "excluded": {"2026-07-10", "2026-07-11"},
            "reward_dirs": [source_root / "raw_2026-07"],
        },
        "2026-08": {
            "start": dt.date(2026, 8, 1),
            "end": dt.date(2026, 8, 31),
            "excluded": set(),
            "reward_dirs": [source_root / "raw_2026-08_09"],
        },
        "2026-09": {
            "start": dt.date(2026, 9, 1),
            "end": dt.date(2026, 9, 30),
            "excluded": set(),
            "reward_dirs": [source_root / "v4_2026-09-30" / "reward_full_month"],
        },
    }


def reward_files(configs: dict[str, dict[str, Any]]) -> list[Path]:
    unique: dict[str, Path] = {}
    for config in configs.values():
        for directory in config["reward_dirs"]:
            for path in sorted(directory.glob("*.csv")):
                unique[str(path.resolve()).lower()] = path
    return list(unique.values())


def merge_value(existing: str, incoming: str) -> str:
    return existing or incoming


def load_orders(files: list[Path]) -> tuple[dict[str, dict[str, str]], dict[str, Any]]:
    required = {"訂單號", "帳號", "外觀卡號", "分類", "借車時間", "借車縣市", "還車時間", "還車縣市"}
    orders: dict[str, dict[str, str]] = {}
    audit: Counter[str] = Counter()
    sources = []
    for path in files:
        rows = 0
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not required.issubset(reader.fieldnames or []):
                audit["skippedFilesMissingColumns"] += 1
                continue
            for row in reader:
                rows += 1
                audit["sourceRows"] += 1
                order_id = str(row.get("訂單號") or "").strip()
                if not order_id:
                    audit["missingOrderRows"] += 1
                    continue
                incoming = {
                    "account": str(row.get("帳號") or "").strip(),
                    "card": normalize_card(row.get("外觀卡號") or ""),
                    "category": str(row.get("分類") or "").strip(),
                    "borrow": str(row.get("借車時間") or "").strip(),
                    "borrow_city": normalize_city(row.get("借車縣市") or ""),
                    "return": str(row.get("還車時間") or "").strip(),
                    "return_city": normalize_city(row.get("還車縣市") or ""),
                }
                existing = orders.get(order_id)
                if existing is None:
                    orders[order_id] = incoming
                    continue
                audit["duplicateRows"] += 1
                existing["category"] = " ".join(sorted(set(existing["category"].split()) | set(incoming["category"].split())))
                if existing["card"] and incoming["card"] and existing["card"] != incoming["card"]:
                    audit["conflictingCardRows"] += 1
                for key in ("account", "card", "borrow", "borrow_city", "return", "return_city"):
                    existing[key] = merge_value(existing[key], incoming[key])
        sources.append({"file": path.name, "rows": rows, "bytes": path.stat().st_size})
    audit["uniqueOrders"] = len(orders)
    return orders, {"counts": dict(audit), "files": sources}


def build_payloads(
    configs: dict[str, dict[str, Any]],
    orders: dict[str, dict[str, str]],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    daily: dict[str, dict[str, list[int]]] = {month: defaultdict(lambda: [0, 0]) for month in configs}
    card_variants: dict[str, dict[str, set[str]]] = {month: defaultdict(set) for month in configs}
    audit: Counter[str] = Counter()

    for order in orders.values():
        if not order["account"].startswith("09"):
            audit["excludedNonMobileOrders"] += 1
            continue
        suffix = card_suffix(order["card"])
        if suffix is None:
            audit["missingOrShortCardOrders"] += 1
            continue
        audit["eligibleOrders"] += 1
        for label, metric_index, time_field, city_field in (("滿借", 0, "borrow", "borrow_city"), ("空還", 1, "return", "return_city")):
            if label not in order["category"]:
                continue
            if order[city_field] not in {"台北市", "新北市"}:
                audit[f"excludedOutOfScope{label}"] += 1
                continue
            timestamp = parse_datetime(order[time_field])
            if timestamp is None:
                audit["badTimestamps"] += 1
                continue
            month = timestamp.strftime("%Y-%m")
            config = configs.get(month)
            if config is None or not config["start"] <= timestamp.date() <= config["end"]:
                continue
            date_text = timestamp.date().isoformat()
            if date_text in config["excluded"]:
                audit[f"excluded{label}"] += 1
                continue
            daily[month][f"{suffix}|{date_text}"][metric_index] += 1
            card_variants[month][suffix].add(order["card"])
            audit[f"included{label}"] += 1

    payloads: dict[str, dict[str, Any]] = {}
    outputs = []
    for month, config in configs.items():
        dates = []
        current = config["start"]
        while current <= config["end"]:
            date_text = current.isoformat()
            if date_text not in config["excluded"]:
                dates.append(date_text)
            current += dt.timedelta(days=1)
        date_index = {date: index for index, date in enumerate(dates)}
        cards: dict[str, dict[str, Any]] = {}
        for combined_key, counts in sorted(daily[month].items()):
            suffix, date_text = combined_key.split("|", 1)
            record = cards.setdefault(suffix, {"n": len(card_variants[month][suffix]), "d": []})
            record["d"].append([date_index[date_text], counts[0], counts[1]])
        collision_suffixes = sum(record["n"] > 1 for record in cards.values())
        payload = {
            "version": "v1",
            "month": month,
            "dates": dates,
            "cards": cards,
            "meta": {
                "periodStart": config["start"].isoformat(),
                "periodEnd": config["end"].isoformat(),
                "excludedDates": sorted(config["excluded"]),
                "suffixLength": 5,
                "suffixCount": len(cards),
                "collisionSuffixCount": collision_suffixes,
                "fullEvents": sum(counts[0] for counts in daily[month].values()),
                "emptyEvents": sum(counts[1] for counts in daily[month].values()),
                "privacy": "Only normalized card suffixes and daily aggregate counts are stored; full card numbers, accounts, order IDs, stations and timestamps are excluded.",
            },
        }
        payloads[month] = payload
        outputs.append({"month": month, **payload["meta"]})
    return payloads, {"counts": dict(audit), "outputs": outputs}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-root",
        type=Path,
        default=Path.home() / "Documents" / "暫停營運測試" / "cps_reward_log",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "dist" / "data",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "card-build-summary.json",
    )
    args = parser.parse_args()

    configs = month_configs(args.source_root)
    missing = [str(directory) for config in configs.values() for directory in config["reward_dirs"] if not directory.exists()]
    if missing:
        raise RuntimeError("Missing sources: " + json.dumps(missing, ensure_ascii=False))

    orders, source_audit = load_orders(reward_files(configs))
    payloads, build_audit = build_payloads(configs, orders)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for month, payload in payloads.items():
        output = args.output_dir / f"cards-{month}.js"
        output.write_text(OUTPUT_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";", encoding="utf-8")

    summary = {
        "version": "v1",
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "sourceAudit": source_audit,
        "buildAudit": build_audit,
    }
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
