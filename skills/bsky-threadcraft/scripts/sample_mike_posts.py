#!/usr/bin/env python3
"""Sample @mike10010100.com's pre-threadcraft Bluesky corpus with local caching, self-thread reconstruction, and mode-aware stratification."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import re
import sys
import urllib.parse
import urllib.request

DEFAULT_DID = "did:plc:mmtjkssv6jeneahkgfdxuy7p"
DEFAULT_PDS = "https://shimeji.us-east.host.bsky.network"
B32_CHARS = "234567abcdefghijklmnopqrstuvwxyz"
CORPUS_SCHEMA_VERSION = 4

# Frozen pre-threadcraft window (2023-06-15 -> 2026-10-30) to prevent AI feedback loops
START_TS = int(datetime(2023, 6, 15, tzinfo=timezone.utc).timestamp())
END_TS = int(datetime(2026, 10, 30, tzinfo=timezone.utc).timestamp())
CUTOFF_ISO = "2026-10-30"

DEFAULT_CACHE_PATH = Path.home() / ".cache" / "bsky-threadcraft" / "mike_corpus_v3.json"

URL_RE = re.compile(r"https?://\S+|(?:www\.|[a-z0-9-]+\.(?:com|org|net|gov|edu|io|app|social))/\S*", re.IGNORECASE)

MODE_WEIGHTS: dict[str, dict[str, float]] = {
    "auto": {"SELF-THREAD": 0.25, "POST": 0.20, "QUOTE": 0.25, "REPLY": 0.30},
    "explainer": {"SELF-THREAD": 0.42, "POST": 0.23, "QUOTE": 0.20, "REPLY": 0.15},
    "quote": {"QUOTE": 0.50, "SELF-THREAD": 0.20, "POST": 0.15, "REPLY": 0.15},
    "reply": {"REPLY": 0.55, "QUOTE": 0.20, "SELF-THREAD": 0.15, "POST": 0.10},
}


def timestamp_to_tid(ts_seconds: float) -> str:
    micros = int(ts_seconds * 1_000_000)
    val = (micros << 10) & ((1 << 63) - 1)
    chars = []
    for _ in range(13):
        chars.append(B32_CHARS[val & 0x1F])
        val >>= 5
    return "".join(reversed(chars))


MENTION_RE = re.compile(r"@[a-z0-9.-]+\.[a-z]{2,}", re.IGNORECASE)


def prose_length(text: str) -> int:
    stripped = URL_RE.sub("", text)
    stripped = MENTION_RE.sub("", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()
    return len(stripped)


def fetch_slice(pds: str, did: str, cursor_tid: str, limit: int = 100) -> list[dict]:
    params = {
        "repo": did,
        "collection": "app.bsky.feed.post",
        "limit": limit,
        "cursor": cursor_tid,
    }
    url = f"{pds}/xrpc/com.atproto.repo.listRecords?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "bsky-threadcraft-sampler/3.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("records", [])


def build_corpus_from_pds(
    pds: str,
    did: str,
    num_slices: int = 48,
    min_chars: int = 35,
    seed: int = 20261030,
) -> list[dict]:
    """Fetch evenly stratified historical slices across 2023-2026 and reconstruct self-threads."""
    rng = random.Random(seed)
    span = (END_TS - START_TS) / max(num_slices, 1)
    cursors = [
        timestamp_to_tid(START_TS + (i + rng.uniform(0.08, 0.92)) * span)
        for i in range(num_slices)
    ]

    raw_by_uri: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(fetch_slice, pds, did, tid, 100) for tid in cursors]
        for fut in futures:
            try:
                records = fut.result()
            except Exception:
                continue
            for rec in records:
                uri = rec.get("uri", "")
                if not uri or uri in raw_by_uri:
                    continue
                val = rec.get("value", {})
                created_at = val.get("createdAt", "")
                text = (val.get("text") or "").strip()
                if not text or not created_at or created_at >= CUTOFF_ISO:
                    continue
                raw_by_uri[uri] = {
                    "uri": uri,
                    "text": text,
                    "createdAt": created_at,
                    "day": created_at[:10],
                    "replyParent": val.get("reply", {}).get("parent", {}).get("uri"),
                    "replyRoot": val.get("reply", {}).get("root", {}).get("uri"),
                    "embedType": val.get("embed", {}).get("$type", ""),
                }

    self_prefix = f"at://{did}/"

    # Reconstruct authored multi-post self-threads where root & parent are both authored by Mike
    threads_by_root: dict[str, list[dict]] = {}
    consumed_uris: set[str] = set()

    for uri, item in raw_by_uri.items():
        r_root = item["replyRoot"]
        r_parent = item["replyParent"]
        if r_root and r_parent and r_root.startswith(self_prefix) and r_parent.startswith(self_prefix):
            threads_by_root.setdefault(r_root, []).append(item)

    corpus: list[dict] = []

    for root_uri, replies in threads_by_root.items():
        nodes = list(replies)
        if root_uri in raw_by_uri:
            nodes.append(raw_by_uri[root_uri])
        nodes.sort(key=lambda x: x["createdAt"])

        # Walk contiguous parent->child chain starting from earliest available post in this self-thread
        by_parent: dict[str, list[dict]] = {}
        node_uris = {n["uri"] for n in nodes}
        for n in nodes:
            p = n["replyParent"]
            if p and p in node_uris:
                by_parent.setdefault(p, []).append(n)

        heads = [n for n in nodes if not n["replyParent"] or n["replyParent"] not in node_uris]
        if not heads:
            continue
        head = sorted(heads, key=lambda x: x["createdAt"])[0]
        chain = [head]
        cur = head
        while cur["uri"] in by_parent and len(chain) < 8:
            nxt = sorted(by_parent[cur["uri"]], key=lambda x: x["createdAt"])[0]
            if nxt in chain:
                break
            chain.append(nxt)
            cur = nxt

        if len(chain) >= 2:
            substantive_posts = [c for c in chain if prose_length(c["text"]) >= min_chars]
            if prose_length(chain[0]["text"]) >= max(min_chars, 45) and len(substantive_posts) >= 2:
                for c in chain:
                    consumed_uris.add(c["uri"])
                # Keep up to 4 posts (first 3 + final button post if longer) so single examples stay compact
                if len(chain) <= 4:
                    display_posts = chain
                else:
                    display_posts = chain[:3] + [chain[-1]]
                formatted = "\n   ---\n   ".join(
                    f"[Post {i+1}/{len(chain)}] {p['text']}"
                    for i, p in enumerate(display_posts)
                )
                corpus.append({
                    "kind": "SELF-THREAD",
                    "createdAt": chain[0]["day"],
                    "text": formatted,
                    "postCount": len(chain),
                })

    # Classify remaining individual records
    for uri, item in sorted(raw_by_uri.items(), key=lambda kv: kv[1]["createdAt"]):
        if uri in consumed_uris:
            continue
        if prose_length(item["text"]) < min_chars:
            continue

        r_parent = item["replyParent"]
        is_quote = "record" in (item["embedType"] or "")

        if r_parent:
            if r_parent.startswith(self_prefix):
                # Isolated self-reply whose parent wasn't in the slice; skip so fragments don't confuse framing
                continue
            kind = "REPLY"
        elif is_quote:
            kind = "QUOTE"
        else:
            kind = "POST"

        corpus.append({
            "kind": kind,
            "createdAt": item["day"],
            "text": item["text"],
        })

    return corpus


def load_or_build_corpus(
    pds: str,
    did: str,
    cache_path: Path,
    slices: int,
    min_chars: int,
    use_cache: bool = True,
    refresh_cache: bool = False,
) -> tuple[list[dict], bool]:
    if use_cache and not refresh_cache and cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cached = json.load(f)
            if (
                cached.get("schema_version") == CORPUS_SCHEMA_VERSION
                and cached.get("did") == did
                and isinstance(cached.get("corpus"), list)
                and len(cached["corpus"]) >= 100
            ):
                return cached["corpus"], True
        except Exception:
            pass

    effective_slices = max(slices, 48) if use_cache else slices
    corpus = build_corpus_from_pds(pds, did, num_slices=effective_slices, min_chars=min_chars)

    if use_cache and corpus:
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = cache_path.with_suffix(f".tmp.{os.getpid()}")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "schema_version": CORPUS_SCHEMA_VERSION,
                        "did": did,
                        "cutoff": CUTOFF_ISO,
                        "built_at": datetime.now(timezone.utc).isoformat(),
                        "corpus": corpus,
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp_path, cache_path)
        except Exception:
            pass

    return corpus, False


def stratified_sample(
    corpus: list[dict],
    count: int,
    mode: str,
    rng: random.Random,
    max_per_day: int = 2,
) -> list[dict]:
    weights = MODE_WEIGHTS.get(mode, MODE_WEIGHTS["auto"])
    by_kind: dict[str, list[dict]] = {"SELF-THREAD": [], "POST": [], "QUOTE": [], "REPLY": []}
    for item in corpus:
        k = item.get("kind", "POST")
        by_kind.setdefault(k, []).append(item)

    for items in by_kind.values():
        rng.shuffle(items)

    day_counts: dict[str, int] = {}
    selected: list[dict] = []
    selected_ids: set[int] = set()

    def try_take(bucket: list[dict], target_n: int, enforce_day_cap: bool = True) -> int:
        taken = 0
        for item in bucket:
            if taken >= target_n:
                break
            obj_id = id(item)
            if obj_id in selected_ids:
                continue
            day = item.get("createdAt", "")
            if enforce_day_cap and day and day_counts.get(day, 0) >= max_per_day:
                continue
            selected.append(item)
            selected_ids.add(obj_id)
            if day:
                day_counts[day] = day_counts.get(day, 0) + 1
            taken += 1
        return taken

    # First pass: take weighted targets per kind with per-day anti-clustering cap
    for kind, weight in weights.items():
        quota = round(count * weight)
        try_take(by_kind.get(kind, []), quota, enforce_day_cap=True)

    # Second pass: top up from remaining items in priority order (still respecting day cap)
    priority_kinds = sorted(weights.keys(), key=lambda k: weights[k], reverse=True)
    for kind in priority_kinds:
        if len(selected) >= count:
            break
        try_take(by_kind.get(kind, []), count - len(selected), enforce_day_cap=True)

    # Final fallback: relax day cap only if corpus is tiny
    if len(selected) < count:
        for kind in priority_kinds:
            if len(selected) >= count:
                break
            try_take(by_kind.get(kind, []), count - len(selected), enforce_day_cap=False)

    # Group SELF-THREAD examples first when mode=explainer so multi-post rhythm is immediately visible,
    # then shuffle remaining items cleanly
    if mode == "explainer":
        threads = [x for x in selected if x.get("kind") == "SELF-THREAD"]
        others = [x for x in selected if x.get("kind") != "SELF-THREAD"]
        rng.shuffle(threads)
        rng.shuffle(others)
        return (threads + others)[:count]

    rng.shuffle(selected)
    return selected[:count]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--did", default=DEFAULT_DID, help="Bluesky repo DID")
    parser.add_argument("--pds", default=DEFAULT_PDS, help="PDS endpoint")
    parser.add_argument(
        "--mode",
        choices=["auto", "explainer", "quote", "reply"],
        default="auto",
        help="Stratify voice sample toward thread format (explainer, quote, reply, or auto)",
    )
    parser.add_argument("--count", type=int, default=75, help="Number of entries to sample (default: 75)")
    parser.add_argument("--slices", type=int, default=48, help="Historical slices when building corpus")
    parser.add_argument("--min-chars", type=int, default=35, help="Minimum non-URL prose character length")
    parser.add_argument("--cache-path", type=Path, default=DEFAULT_CACHE_PATH, help="Local corpus cache path")
    parser.add_argument("--refresh-cache", action="store_true", help="Force rebuild of local corpus cache from PDS")
    parser.add_argument("--no-cache", action="store_true", help="Bypass reading/writing local corpus cache")
    parser.add_argument("--seed", type=int, default=None, help="Optional RNG seed for reproducible sampling")
    parser.add_argument("--output", "-o", help="Output file path (defaults to stdout)")
    args = parser.parse_args()

    corpus, from_cache = load_or_build_corpus(
        pds=args.pds,
        did=args.did,
        cache_path=args.cache_path,
        slices=args.slices,
        min_chars=args.min_chars,
        use_cache=not args.no_cache,
        refresh_cache=args.refresh_cache,
    )

    rng = random.Random(args.seed)
    sample_size = min(max(args.count, 1), len(corpus))
    sampled = stratified_sample(corpus, sample_size, args.mode, rng)

    kind_summary: dict[str, int] = {}
    for item in sampled:
        k = item.get("kind", "POST")
        kind_summary[k] = kind_summary.get(k, 0) + 1
    breakdown = ", ".join(f"{k}={v}" for k, v in sorted(kind_summary.items()))
    source_tag = "local-cache" if from_cache else "live-pds"

    lines = [
        f"# Stratified Voice Sample of {len(sampled)} Entries by @mike10010100.com (mode={args.mode}; {breakdown}; pool={len(corpus)}; source={source_tag})",
        "# Read this sample to absorb sentence cadence, paragraph breaks, thread transitions, and baseline register.",
        "# Do NOT copy specific one-off slang, jokes, or openers (e.g. 'TBF,') as a formula.",
        "",
    ]
    for idx, item in enumerate(sampled, 1):
        clean_text = item["text"].replace("\n", "\n   ")
        lines.append(f"{idx}. [{item['createdAt']} {item['kind']}] {clean_text}")

    output_text = "\n".join(lines) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_text)
        print(
            f"Wrote {len(sampled)} mode={args.mode} entries ({breakdown}; {len(output_text):,} bytes; {source_tag}) to {args.output}"
        )
    else:
        sys.stdout.write(output_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
