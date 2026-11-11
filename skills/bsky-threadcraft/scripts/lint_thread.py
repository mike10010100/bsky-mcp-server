#!/usr/bin/env python3
"""Deterministic linter for Bluesky threads: exact ATProto 300-grapheme & 3000-byte checks, parameter validation, punctuation/emoji gates, and WP:AISIGNS heuristics."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import unicodedata

MAX_GRAPHEMES = 300
MAX_UTF8_BYTES = 3000
MAX_IMAGES_PER_POST = 4

FORBIDDEN_THREAD_KEYS = {
    "replyToUri": "Use 'replyTo' instead of 'replyToUri'",
    "parentUri": "Use 'replyTo' at the top level instead of 'parentUri'",
}

FORBIDDEN_POST_KEYS = {
    "replyToUri": "Use top-level 'replyTo' on create-thread (or 'replyTo' on create-post), never 'replyToUri'",
    "quotePost": "Use 'quoteUri' instead of 'quotePost'",
    "altTexts": "Use 'imageAlts' instead of 'altTexts'",
    "images": "Use 'imagePaths' instead of 'images'",
    "uri": "Post draft objects should not specify 'uri'",
}

ALLOWED_POST_KEYS = {"text", "quoteUri", "imagePaths", "imageAlts", "previewUrl", "embedPreview"}

DEFAULT_AI_VOCAB = [
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

URL_RE = re.compile(r"https?://\S+")

# Emoji ranges (Supplementary Pictographs, Emoticons, Transport, Dingbats, Misc Symbols, Regional Flags)
EMOJI_RE = re.compile(
    "["
    "\U0001F1E6-\U0001F1FF"  # Regional indicator flags
    "\U0001F300-\U0001F5FF"  # Misc symbols & pictographs (includes 🧵 U+1F9F5 below)
    "\U0001F600-\U0001F64F"  # Emoticons
    "\U0001F680-\U0001F6FF"  # Transport & map
    "\U0001F700-\U0001F77F"
    "\U0001F780-\U0001F7FF"
    "\U0001F800-\U0001F8FF"
    "\U0001F900-\U0001F9FF"  # Supplemental symbols & pictographs (🧵 is U+1F9F5)
    "\U0001FA00-\U0001FAFF"  # Chess & Symbols/Pictographs Extended-A
    "\u2600-\u26FF"          # Misc symbols
    "\u2700-\u27BF"          # Dingbats
    "]"
)

NEGATIVE_PARALLELISM_PATTERNS = [
    (
        "not just/only X, but/it's Y",
        re.compile(
            r"\bnot\s+(?:just|only|merely|simply)\b[^.!?\n]{1,90}?\b(?:but\b|it['’]s\b|it\s+is\b|they['’]re\b|they\s+are\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "isn't X; it's Y",
        re.compile(
            r"\b(?:isn['’]t|is\s+not|aren['’]t|are\s+not|wasn['’]t|weren['’]t|doesn['’]t|don['’]t)\s+(?:just\s+|merely\s+|simply\s+)?(?:about\s+)?[^.,;:!?\n]{2,55}[,;:]\s*(?:it['’]s|it\s+is|they['’]re|they\s+are|rather\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "not X, but rather Y",
        re.compile(r"\bnot\s+[^.,;:!?\n]{2,45},\s*but\s+(?:rather\s+)?", re.IGNORECASE),
    ),
    (
        "no X, no Y, just Z",
        re.compile(r"\bno\s+[^.,;:!?\n]{1,30},\s*no\s+[^.,;:!?\n]{1,30},\s*just\b", re.IGNORECASE),
    ),
    (
        "less about X, more about Y",
        re.compile(r"\bless\s+about\b[^.!?\n]{1,60}?\bmore\s+about\b", re.IGNORECASE),
    ),
]

COPULA_AVOIDANCE_RE = re.compile(
    r"\b(?:serves|served|stands|stood|functions|operates)\s+as\s+(?:a|an|the)\b"
    r"|\bholds\s+the\s+distinction\s+of\b"
    r"|\bmarks\s+(?:a|an|the)\s+(?:pivotal|major|significant|historic|watershed)\b",
    re.IGNORECASE,
)

SUPERFICIAL_ING_RE = re.compile(
    r",\s+(?:highlighting|underscoring|reflecting|showcasing|demonstrating|illustrating|fostering|reinforcing|signaling|cementing|solidifying)\b",
    re.IGNORECASE,
)

ESSAY_SIGNPOST_RE = re.compile(
    r"(?:^|\n)\s*(?:First|Second|Third|Firstly|Secondly|Thirdly|Furthermore|Moreover|In\s+conclusion|To\s+summarize|Ultimately),",
    re.IGNORECASE,
)

CANNED_EXPLAINER_OPENER_RE = re.compile(
    r"^\s*(?:TBF,|To\s+be\s+fair,|Let['’]s\s+(?:unpack|dive\s+into|explore|break\s+down)|It['’]s\s+important\s+to\s+(?:remember|note|understand))",
    re.IGNORECASE,
)

# Lowercase lexical triad ("housing, healthcare, and labor" or "innovative, transformative, and bold")
# Case-sensitive on [a-z] so proper-noun factual lists ("Pelosi, Stevens, and Correa") don't spam noise
LOWERCASE_TRIAD_RE = re.compile(
    r"\b([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,})?),\s+([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,})?),?\s+and\s+([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,})?)\b"
)


def find_node_binary() -> str | None:
    for candidate in (
        shutil.which("node"),
        "/home/linuxbrew/.linuxbrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ):
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def python_grapheme_count(text: str) -> int:
    """Pure-Python UAX #29 approximation handling CRLF, combining marks, variation selectors, skin tones, RI flags, and ZWJ sequences."""
    count = 0
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        # CRLF is a single grapheme cluster
        if ch == "\r" and i + 1 < n and text[i + 1] == "\n":
            count += 1
            i += 2
            continue

        count += 1
        i += 1

        # Regional indicator pair (flags like 🇺🇸 = two RI codepoints)
        if "\U0001F1E6" <= ch <= "\U0001F1FF" and i < n and "\U0001F1E6" <= text[i] <= "\U0001F1FF":
            i += 1

        # Absorb trailing extending marks, variation selectors, skin-tone modifiers, and ZWJ-linked clusters
        while i < n:
            nxt = text[i]
            cat = unicodedata.category(nxt)
            cp = ord(nxt)
            if (
                cat in ("Mn", "Mc", "Me")
                or 0xFE00 <= cp <= 0xFE0F
                or 0xE0100 <= cp <= 0xE01EF
                or 0x1F3FB <= cp <= 0x1F3FF
                or cp == 0x200C
            ):
                i += 1
            elif cp == 0x200D and i + 1 < n:
                # Zero-Width Joiner glues the next base character into the same grapheme cluster
                i += 2
            else:
                break
    return count


def batch_grapheme_counts(texts: list[str]) -> list[int]:
    """Use Node V8 Intl.Segmenter when available for 100% parity with @atproto/api RichText, else pure Python."""
    node_bin = find_node_binary()
    if node_bin and texts:
        js = (
            "const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });"
            "const arr = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
            "process.stdout.write(JSON.stringify(arr.map(s => [...seg.segment(s)].length)));"
        )
        try:
            res = subprocess.run(
                [node_bin, "-e", js],
                input=json.dumps(texts),
                text=True,
                capture_output=True,
                timeout=5,
                check=True,
            )
            parsed = json.loads(res.stdout)
            if isinstance(parsed, list) and len(parsed) == len(texts):
                return [int(x) for x in parsed]
        except Exception:
            pass
    return [python_grapheme_count(t) for t in texts]


def load_ai_vocab(rules_path: Path | None) -> list[str]:
    if rules_path and rules_path.exists():
        try:
            with open(rules_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            words = data.get("ai_vocabulary")
            if isinstance(words, list) and words:
                return sorted(set(str(w).lower() for w in words) | set(DEFAULT_AI_VOCAB))
        except Exception:
            pass
    return DEFAULT_AI_VOCAB


def parse_draft_payload(raw: object) -> tuple[list[dict], list[str]]:
    schema_errors: list[str] = []
    posts_raw: list[object] = []

    if isinstance(raw, dict):
        for bad_k, hint in FORBIDDEN_THREAD_KEYS.items():
            if bad_k in raw:
                schema_errors.append(f"Top-level schema key '{bad_k}' is invalid: {hint}")
        if "posts" not in raw or not isinstance(raw["posts"], list):
            schema_errors.append("Top-level object must contain a 'posts' array")
            return [], schema_errors
        posts_raw = raw["posts"]
    elif isinstance(raw, list):
        posts_raw = raw
    else:
        return [], ["Input JSON must be either an array of posts or {'replyTo'?: ..., 'posts': [...]}"]

    normalized: list[dict] = []
    for idx, item in enumerate(posts_raw, 1):
        if isinstance(item, str):
            normalized.append({"text": item})
        elif isinstance(item, dict):
            for bad_k, hint in FORBIDDEN_POST_KEYS.items():
                if bad_k in item:
                    schema_errors.append(f"Post #{idx}: invalid key '{bad_k}' — {hint}")
            unknown = set(item.keys()) - ALLOWED_POST_KEYS - set(FORBIDDEN_POST_KEYS.keys())
            if unknown:
                schema_errors.append(f"Post #{idx}: unrecognized key(s): {', '.join(sorted(unknown))}")
            text = item.get("text")
            if not isinstance(text, str):
                schema_errors.append(f"Post #{idx}: missing or non-string 'text' field")
                text = ""
            normalized.append(item | {"text": text})
        else:
            schema_errors.append(f"Post #{idx}: must be a string or object, got {type(item).__name__}")

    if not normalized and not schema_errors:
        schema_errors.append("Thread contains 0 posts")

    return normalized, schema_errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "draft_file",
        help="Path to JSON thread file (['post1', ...] or {'replyTo'?: ..., 'posts': [...]}) or '-' for stdin",
    )
    parser.add_argument(
        "--rules",
        type=Path,
        default=None,
        help="Optional path to wp_aisigns_rules.json (auto-detected in same directory if omitted)",
    )
    parser.add_argument(
        "--mode",
        choices=["auto", "explainer", "quote", "reply"],
        default="auto",
        help="Thread mode for opener/structure checks",
    )
    parser.add_argument("--allow-emojis", action="store_true", help="Allow emojis when explicitly requested by user")
    parser.add_argument("--strict", action="store_true", help="Treat WP:AISIGNS advisories as non-zero exit code (2)")
    args = parser.parse_args()

    if args.draft_file == "-":
        raw_text = sys.stdin.read()
        base_dir = Path.cwd()
    else:
        p = Path(args.draft_file)
        if not p.exists():
            sys.stderr.write(f"Error: draft file not found: {p}\n")
            return 1
        raw_text = p.read_text(encoding="utf-8")
        base_dir = p.parent

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"Error: invalid JSON in {args.draft_file}: {exc}\n")
        return 1

    rules_path = args.rules or (base_dir / "wp_aisigns_rules.json")
    ai_vocab = load_ai_vocab(rules_path)
    vocab_regexes = [
        (w, re.compile(rf"\b{re.escape(w)}\b", re.IGNORECASE))
        for w in ai_vocab
    ]

    posts, hard_errors = parse_draft_payload(payload)
    advisories: list[str] = []

    texts = [p["text"] for p in posts]
    graphemes_list = batch_grapheme_counts(texts)

    print(f"=== Thread Lint Report ({len(posts)} post(s), mode={args.mode}) ===")

    for idx, (post, g_len) in enumerate(zip(posts, graphemes_list), 1):
        text = post["text"]
        b_len = len(text.encode("utf-8"))
        prose_no_urls = URL_RE.sub("", text)

        post_hard: list[str] = []
        post_adv: list[str] = []

        if not text.strip():
            post_hard.append("Empty post text")
        if g_len > MAX_GRAPHEMES:
            over = g_len - MAX_GRAPHEMES
            post_hard.append(f"EXCEEDS 300 GRAPHEMES by +{over} ({g_len}/300)")
        if b_len > MAX_UTF8_BYTES:
            post_hard.append(f"EXCEEDS 3000 UTF-8 BYTES ({b_len}/3000)")

        # Em-dash and prose double-hyphen checks
        if "\u2014" in text or "\u2015" in text:
            post_hard.append("Contains forbidden em dash ('—')")
        if re.search(r"(?<!-)(?<!:)--(?![->])", prose_no_urls):
            post_hard.append("Contains double-hyphen ('--') em-dash substitute; use comma, colon, parentheses, or period")

        # Emoji gate
        if not args.allow_emojis:
            emoji_hits = EMOJI_RE.findall(text)
            if emoji_hits:
                uniq = "".join(dict.fromkeys(emoji_hits))
                post_hard.append(f"Contains forbidden emoji(s): {uniq}")

        # Image & alt-text validation
        img_paths = post.get("imagePaths")
        img_alts = post.get("imageAlts")
        if img_paths is not None:
            if not isinstance(img_paths, list):
                post_hard.append("'imagePaths' must be an array of strings")
            else:
                if len(img_paths) > MAX_IMAGES_PER_POST:
                    post_hard.append(f"Specifies {len(img_paths)} images (Bluesky max is 4 per post)")
                for ip in img_paths:
                    if not isinstance(ip, str) or not Path(ip).is_file():
                        post_hard.append(f"Image file not found on disk: {ip}")
                if img_paths:
                    if not isinstance(img_alts, list) or len(img_alts) < len(img_paths) or any(not str(a).strip() for a in img_alts[: len(img_paths)]):
                        post_hard.append(
                            f"Every attached image in 'imagePaths' ({len(img_paths)}) must have a non-empty descriptive alt string in 'imageAlts'"
                        )

        # WP:AISIGNS & Voice Advisories (evaluated on non-URL text)
        for label, pat in NEGATIVE_PARALLELISM_PATTERNS:
            for m in pat.finditer(prose_no_urls):
                snippet = re.sub(r"\s+", " ", m.group(0)).strip()
                post_adv.append(f"Negative parallelism ({label}): \"{snippet}\"")

        for m in COPULA_AVOIDANCE_RE.finditer(prose_no_urls):
            post_adv.append(f"Copulative avoidance ('is/has' replacement): \"{m.group(0)}\"")

        for m in SUPERFICIAL_ING_RE.finditer(prose_no_urls):
            post_adv.append(f"Superficial trailing '-ing' clause: \"{m.group(0).strip()}\"")

        for m in ESSAY_SIGNPOST_RE.finditer(prose_no_urls):
            post_adv.append(f"Mechanical essay signpost: \"{m.group(0).strip()}\"")

        for m in LOWERCASE_TRIAD_RE.finditer(prose_no_urls):
            post_adv.append(f"Possible 'Rule of Three' triad (verify factual necessity vs LLM cadence): \"{m.group(0)}\"")

        if idx == 1 and args.mode in ("explainer", "auto"):
            m_open = CANNED_EXPLAINER_OPENER_RE.search(prose_no_urls)
            if m_open:
                post_adv.append(f"Formulaic opener on Post #1: \"{m_open.group(0).strip()}\"")

        matched_vocab: list[str] = []
        for word, vpat in vocab_regexes:
            if vpat.search(prose_no_urls):
                matched_vocab.append(word)
        if matched_vocab:
            post_adv.append(f"WP:AISIGNS watchword(s): {', '.join(matched_vocab)}")

        # Check verb 'highlight/highlights/highlighted/highlighting' outside quotes
        m_hl = re.search(r"\bhighlight(?:s|ed|ing)\b", prose_no_urls, re.IGNORECASE)
        if m_hl:
            post_adv.append(f"WP:AISIGNS watchword: \"{m_hl.group(0)}\"")

        status = "FAIL" if post_hard else ("WARN" if post_adv else "PASS")
        rem = MAX_GRAPHEMES - g_len
        delta_str = f"{rem} left" if rem >= 0 else f"OVER BY +{-rem}"
        print(f"  Post #{idx}: {g_len:3d}/300 graphemes ({delta_str}) | {b_len:3d} B | {status}")

        for err in post_hard:
            print(f"    [ERROR] {err}")
            hard_errors.append(f"Post #{idx}: {err}")
        for adv in post_adv:
            print(f"    [WARN]  {adv}")
            advisories.append(f"Post #{idx}: {adv}")

    if hard_errors:
        print(f"\nRESULT: FAILED ({len(hard_errors)} hard error(s), {len(advisories)} advisory warning(s))")
        for err in hard_errors:
            if not err.startswith("Post #"):
                print(f"  [ERROR] {err}")
        return 1

    if advisories:
        print(
            f"\nRESULT: PASSED HARD GATES with {len(advisories)} WP:AISIGNS advisory warning(s) — review and rewrite unless inside a verbatim quote."
        )
        return 2 if args.strict else 0

    print("\nRESULT: ALL HARD GATES & WP:AISIGNS CHECKS PASSED CLEANLY (0 errors, 0 warnings)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
