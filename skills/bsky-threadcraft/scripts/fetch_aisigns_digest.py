#!/usr/bin/env python3
"""Fetch, revision-cache, and distill live 'Wikipedia:Signs of AI writing' (WP:AISIGNS) into a compact <18 KB prose digest + JSON ruleset."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

WIKI_API = "https://en.wikipedia.org/w/api.php"
PAGE_TITLE = "Wikipedia:Signs_of_AI_writing"
USER_AGENT = "bsky-threadcraft-aisigns/2.0 (https://bsky.app/profile/mike10010100.com)"
DIGEST_SCHEMA_VERSION = 4

DEFAULT_CACHE_PATH = Path.home() / ".cache" / "bsky-threadcraft" / "wp_aisigns_cache.json"

# Keep prose/rhetoric sections; drop Wikipedia-internal editing/citation/AfC/userpage procedural sections
INCLUDED_H2 = {
    "content",
    "language and grammar",
    "style",
    "signs of human writing",
    "historical indicators",
}

EXCLUDED_SUBHEADINGS = {
    '"awards and recognition" section',
    "awards and recognition section",
    "leads treating wikipedia lists or broad article titles as proper nouns",
    "statements about knowledge cutoffs (2022–2023)",
    "statements about knowledge cutoffs (2022-2023)",
    "section summaries",
    "prompt refusal",
    "abrupt cut offs",
    "outdated ''access-date'' parameters",
    "outdated access-date parameters",
    "internal links",
    "external links",
}

BASELINE_WATCH_WORDS = [
    "additionally",
    "align with",
    "aligns with",
    "aligned with",
    "beacon",
    "boasts",
    "bolster",
    "bolstered",
    "bolstering",
    "crucial",
    "crux",
    "deep dive",
    "delve",
    "delves",
    "delving",
    "emphasizing",
    "enduring",
    "enhance",
    "enhancing",
    "exemplifies",
    "exemplify",
    "foster",
    "fostering",
    "garner",
    "garnered",
    "interplay",
    "intertwine",
    "intertwined",
    "intricacies",
    "intricate",
    "meticulous",
    "meticulously",
    "multifaceted",
    "nuanced",
    "paramount",
    "pivotal",
    "plethora",
    "showcase",
    "showcases",
    "showcasing",
    "stark",
    "tapestry",
    "testament",
    "underscore",
    "underscored",
    "underscores",
    "underscoring",
    "vibrant",
]


def wiki_get_json(params: dict[str, str]) -> dict:
    url = f"{WIKI_API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_latest_revid() -> tuple[int, str]:
    data = wiki_get_json(
        {
            "action": "query",
            "titles": PAGE_TITLE,
            "prop": "revisions",
            "rvprop": "ids|timestamp",
            "format": "json",
            "formatversion": "2",
        }
    )
    pages = data.get("query", {}).get("pages", [])
    if not pages or "revisions" not in pages[0]:
        raise RuntimeError("No revisions returned for Wikipedia:Signs_of_AI_writing")
    rev = pages[0]["revisions"][0]
    return int(rev["revid"]), str(rev.get("timestamp", ""))


def fetch_wikitext() -> str:
    data = wiki_get_json(
        {
            "action": "parse",
            "page": PAGE_TITLE,
            "prop": "wikitext",
            "format": "json",
        }
    )
    return data["parse"]["wikitext"]["*"]


def strip_collapsed_and_refs(text: str) -> str:
    # Remove HTML comments first
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    # IMPORTANT: Strip self-closing <ref ... /> BEFORE paired <ref ...>...</ref> so [^>]* never swallows across sections!
    text = re.sub(r"<ref\b[^>]*/\s*>", "", text, flags=re.IGNORECASE)
    text = re.sub(r"<ref\b[^>]*>.*?</ref>", "", text, flags=re.DOTALL | re.IGNORECASE)

    # Remove {{cot...}} ... {{cob}} collapsed example blocks line-by-line (handles nested templates inside {{cot|...}})
    kept_lines: list[str] = []
    cot_depth = 0
    for line in text.splitlines():
        if re.search(r"\{\{\s*(?:cot|collapse\s+top)\b", line, re.IGNORECASE):
            cot_depth += 1
            continue
        if re.search(r"\{\{\s*(?:cob|collapse\s+bottom)\b", line, re.IGNORECASE):
            cot_depth = max(0, cot_depth - 1)
            continue
        if cot_depth == 0:
            kept_lines.append(line)
    return "\n".join(kept_lines)


def transform_templates(text: str) -> tuple[str, list[str]]:
    """Walk balanced {{...}} templates, keeping inline prose templates and extracting tmbox watchlists."""
    watchboxes: list[str] = []

    def resolve_inner(s: str) -> str:
        out: list[str] = []
        i = 0
        n = len(s)
        while i < n:
            if s.startswith("{{", i):
                depth = 1
                j = i + 2
                while j < n and depth > 0:
                    if s.startswith("{{", j):
                        depth += 1
                        j += 2
                    elif s.startswith("}}", j):
                        depth -= 1
                        j += 2
                    else:
                        j += 1
                raw_inner = s[i + 2 : j - 2] if depth == 0 else s[i + 2 :]
                resolved = resolve_inner(raw_inner)
                parts = resolved.split("|")
                tname = parts[0].strip().lower()

                if tname in ("xt", "!xt", "mxt", "!mxt"):
                    val = parts[1].strip() if len(parts) > 1 else ""
                    out.append(f'"{val}"')
                elif tname in ("strong", "b"):
                    val = parts[1].strip() if len(parts) > 1 else ""
                    out.append(f"**{val}**")
                elif tname in ("em", "i"):
                    val = parts[1].strip() if len(parts) > 1 else ""
                    out.append(f"*{val}*")
                elif tname == "highlight":
                    val = parts[1].strip() if len(parts) > 1 else ""
                    out.append(val)
                elif tname == "tmbox":
                    for p in parts[1:]:
                        if p.strip().startswith("text="):
                            cleaned_box = clean_inline_wiki(p.strip()[5:].strip())
                            watchboxes.append(cleaned_box)
                            out.append(f"\n> {cleaned_box}\n")
                # Drop quote frame, textdiff, blockquote, mbox, shortcut, see also, bi, slink, etc.
                i = j
            else:
                out.append(s[i])
                i += 1
        return "".join(out)

    transformed = resolve_inner(text)
    return transformed, watchboxes


def clean_inline_wiki(text: str) -> str:
    text = re.sub(r"<var>(.*?)</var>", r"\1", text, flags=re.IGNORECASE)
    text = re.sub(r"</?(?:span|small|nowiki|code|u|s|br)\b[^>]*>", "", text, flags=re.IGNORECASE)
    # Wiki links [[Target|Label]] -> Label, [[Target]] -> Target
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", text)
    # External links [https://... label] -> label
    text = re.sub(r"\[https?://\S+\s+([^\]]+)\]", r"\1", text)
    text = re.sub(r"\[https?://\S+\]", "", text)
    # Bold / italics
    text = re.sub(r"'''(.*?)'''", r"**\1**", text)
    text = re.sub(r"''(.*?)''", r"*\1*", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def extract_live_vocab(raw_wikitext: str) -> list[str]:
    """Extract italicized watchwords from the 'High density of AI vocabulary words' section + baseline."""
    cleaned = strip_collapsed_and_refs(raw_wikitext)
    m = re.search(
        r"===\s*High density of \"AI vocabulary\" words\s*===(.*?)(?:\n===|\Z)",
        cleaned,
        flags=re.DOTALL | re.IGNORECASE,
    )
    found: set[str] = set(BASELINE_WATCH_WORDS)
    if m:
        sec = m.group(1)
        # Extract words from tmbox + GPT-4 / GPT-4o / Grok bullets (skip ultra-generic everyday adjectives from GPT-6 like 'matters' or 'practical')
        box_and_early = "\n".join(
            line
            for line in sec.splitlines()
            if "tmbox" in line.lower()
            or "2023 to mid-2024" in line.lower()
            or "mid-2024 to mid-2025" in line.lower()
            or "mid-2025 to mid-2026" in line.lower()
        )
        # Strip '''bold''' era headers first so ''italic'' word extraction only captures watchwords
        box_and_early = re.sub(r"'''[^']*'''", "", box_and_early)
        for item in re.findall(r"''([^']{3,35})''", box_and_early):
            item = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", item).strip().lower()
            for variant in item.split("/"):
                v = variant.strip(" ,.;:()\"'")
                if v and v not in {"key", "valuable", "is", "are", "has", "not"} and len(v) >= 4:
                    found.add(v)
    return sorted(found)


def distill_wikitext(raw_wikitext: str, revid: int, rev_timestamp: str) -> tuple[str, dict]:
    live_vocab = extract_live_vocab(raw_wikitext)
    stripped = strip_collapsed_and_refs(raw_wikitext)

    lines = stripped.splitlines()
    sections: list[tuple[int, str, list[str]]] = []
    cur_level = 0
    cur_title = ""
    cur_body: list[str] = []

    heading_re = re.compile(r"^(=+)\s*(.*?)\s*\1\s*$")
    for line in lines:
        hm = heading_re.match(line)
        if hm:
            if cur_title:
                sections.append((cur_level, cur_title, cur_body))
            cur_level = len(hm.group(1))
            cur_title = clean_inline_wiki(hm.group(2))
            cur_body = []
        else:
            cur_body.append(line)
    if cur_title:
        sections.append((cur_level, cur_title, cur_body))

    out_lines: list[str] = [
        f"# Live Distilled `WP:AISIGNS` Audit Guide (Wikipedia revid `{revid}`, `{rev_timestamp}`)",
        "",
        "> Auto-distilled from live `Wikipedia:Signs_of_AI_writing` with `<ref>` citations, talk-page archives, and Wikipedia-only markup rules stripped so the full prose checklist fits in a single read.",
        "",
        "## Live High-Density AI Vocabulary Watchlist (`WP:AIVOCAB`)",
        ", ".join(f"`{w}`" for w in live_vocab),
        "",
    ]

    active_h2_included = False
    skip_until_level: int | None = None
    all_watchboxes: list[str] = []

    for level, title, body_lines in sections:
        norm_title = title.lower().strip()
        if level == 2:
            active_h2_included = norm_title in INCLUDED_H2
            skip_until_level = None
            if active_h2_included:
                out_lines.append(f"## {title}")
                out_lines.append("")
            continue

        if not active_h2_included:
            continue

        if skip_until_level is not None:
            if level > skip_until_level:
                continue
            skip_until_level = None

        if norm_title in EXCLUDED_SUBHEADINGS:
            skip_until_level = level
            continue

        raw_body = "\n".join(body_lines)
        transformed_body, boxes = transform_templates(raw_body)
        all_watchboxes.extend(boxes)

        cleaned_paras: list[str] = []
        for raw_line in transformed_body.splitlines():
            cl = clean_inline_wiki(raw_line)
            if not cl or cl in ("**Examples**", "*Examples*", "Examples"):
                continue
            if cl.startswith("—From ") or cl.startswith("-From "):
                continue
            cleaned_paras.append(cl)

        # Keep at most first 3 substantive paragraphs/bullets per subsection so digest stays < 16 KB
        kept = cleaned_paras[:4]
        if not kept and level >= 3:
            out_lines.append(f"{'#' * min(level, 4)} {title}")
            out_lines.append("")
            continue

        out_lines.append(f"{'#' * min(level, 4)} {title}")
        for p in kept:
            # Trim overly long academic meta-paragraphs to 420 chars while keeping bullet lists intact
            if not p.startswith(("*", ">", "-")) and len(p) > 460:
                sentences = re.split(r"(?<=[.!?])\s+", p)
                acc: list[str] = []
                total = 0
                for s in sentences:
                    if total + len(s) > 440 and acc:
                        break
                    acc.append(s)
                    total += len(s) + 1
                p = " ".join(acc)
            out_lines.append(p)
        out_lines.append("")

    digest_md = "\n".join(out_lines).strip() + "\n"
    rules = {
        "schema_version": DIGEST_SCHEMA_VERSION,
        "revid": revid,
        "timestamp": rev_timestamp,
        "ai_vocabulary": live_vocab,
        "watchboxes": all_watchboxes,
    }
    return digest_md, rules


def load_or_fetch_aisigns(
    cache_path: Path,
    force_refresh: bool = False,
) -> tuple[str, dict, str]:
    cached: dict | None = None
    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("schema_version") == DIGEST_SCHEMA_VERSION:
                cached = data
        except Exception:
            cached = None

    try:
        live_revid, live_ts = fetch_latest_revid()
        if (
            not force_refresh
            and cached
            and cached.get("revid") == live_revid
            and isinstance(cached.get("digest_md"), str)
            and isinstance(cached.get("rules"), dict)
        ):
            return cached["digest_md"], cached["rules"], f"cache-hit (revid={live_revid} verified live)"

        raw_wikitext = fetch_wikitext()
        digest_md, rules = distill_wikitext(raw_wikitext, live_revid, live_ts)

        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = cache_path.with_suffix(f".tmp.{os.getpid()}")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "schema_version": DIGEST_SCHEMA_VERSION,
                        "revid": live_revid,
                        "timestamp": live_ts,
                        "fetched_at": datetime.now(timezone.utc).isoformat(),
                        "digest_md": digest_md,
                        "rules": rules,
                    },
                    f,
                    ensure_ascii=False,
                )
            os.replace(tmp_path, cache_path)
        except Exception:
            pass

        return digest_md, rules, f"live-fetch (revid={live_revid})"
    except Exception as net_err:
        if cached and isinstance(cached.get("digest_md"), str) and isinstance(cached.get("rules"), dict):
            sys.stderr.write(f"Warning: Wikipedia live check failed ({net_err}); using cached revid={cached.get('revid')}\n")
            return cached["digest_md"], cached["rules"], f"offline-cache (revid={cached.get('revid')})"

        sys.stderr.write(f"Warning: Wikipedia unreachable ({net_err}) and no cache found; using built-in baseline.\n")
        fallback_rules = {
            "schema_version": DIGEST_SCHEMA_VERSION,
            "revid": 0,
            "timestamp": "baseline",
            "ai_vocabulary": BASELINE_WATCH_WORDS,
            "watchboxes": [],
        }
        fallback_md = (
            "# Fallback `WP:AISIGNS` Audit Guide (Offline Baseline)\n\n"
            "## Watchlist\n"
            + ", ".join(f"`{w}`" for w in BASELINE_WATCH_WORDS)
            + "\n\nPurge em dashes (`—`), compulsive triads, negative parallelisms (`not X, but Y`), copulative avoidance (`serves as`, `stands as`), and superficial `-ing` clauses.\n"
        )
        return fallback_md, fallback_rules, "offline-baseline"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", "-o", required=True, help="Output markdown path (e.g. $SCRATCH_DIR/wp_aisigns_digest.md)")
    parser.add_argument(
        "--rules-output",
        help="Optional output JSON rules path (defaults to wp_aisigns_rules.json beside --output)",
    )
    parser.add_argument("--cache-path", type=Path, default=DEFAULT_CACHE_PATH, help="Local cache file path")
    parser.add_argument("--force-refresh", action="store_true", help="Force re-download and re-distill from Wikipedia")
    args = parser.parse_args()

    out_path = Path(args.output)
    rules_path = Path(args.rules_output) if args.rules_output else out_path.parent / "wp_aisigns_rules.json"

    digest_md, rules, source_status = load_or_fetch_aisigns(
        cache_path=args.cache_path,
        force_refresh=args.force_refresh,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(digest_md)

    rules_path.parent.mkdir(parents=True, exist_ok=True)
    with open(rules_path, "w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2, ensure_ascii=False)

    print(
        f"Wrote WP:AISIGNS digest ({len(digest_md):,} bytes, {digest_md.count(chr(10))} lines; {source_status}) to {out_path} and {rules_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
