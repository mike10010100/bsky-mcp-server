#!/usr/bin/env python3
"""Deterministic, tightly cropped PNG receipt-card renderer for bsky-threadcraft.

Renders crisp 2x Retina PNG cards in <1s via a single headless Chromium CDP session
(zero third-party Python packages required), supporting:
  1. `document` (aliases: `excerpt`, `filing`) — archival primary-source excerpt cards
     with optional key-stat callout strips and multi-color inline `==highlight==` spans.
  2. `post` (aliases: `social`, `quote_chain`) — clean social post / self-thread receipt
     cards (`light` or `dark` surface) with author metadata, connector rails, and highlights.

Outputs ready-to-use `imagePaths` + accessible `imageAlts` compatible with `draft.json`,
`lint_thread.py`, `create-post`, and `create-thread`.
"""

from __future__ import annotations

import argparse
import base64
import glob
import html
import json
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any
import urllib.request

THEMES: dict[str, dict[str, str]] = {
    "blue": {
        "accent": "#1d4ed8",
        "dark_eyebrow": "#93c5fd",
        "badge_bg": "#dbeafe",
        "badge_fg": "#1e40af",
        "badge_border": "#93c5fd",
    },
    "emerald": {
        "accent": "#047857",
        "dark_eyebrow": "#6ee7b7",
        "badge_bg": "#d1fae5",
        "badge_fg": "#065f46",
        "badge_border": "#6ee7b7",
    },
    "green": {
        "accent": "#047857",
        "dark_eyebrow": "#6ee7b7",
        "badge_bg": "#d1fae5",
        "badge_fg": "#065f46",
        "badge_border": "#6ee7b7",
    },
    "sky": {
        "accent": "#0369a1",
        "dark_eyebrow": "#7dd3fc",
        "badge_bg": "#e0f2fe",
        "badge_fg": "#075985",
        "badge_border": "#7dd3fc",
    },
    "crimson": {
        "accent": "#b91c1c",
        "dark_eyebrow": "#fca5a5",
        "badge_bg": "#fee2e2",
        "badge_fg": "#991b1b",
        "badge_border": "#fca5a5",
    },
    "red": {
        "accent": "#b91c1c",
        "dark_eyebrow": "#fca5a5",
        "badge_bg": "#fee2e2",
        "badge_fg": "#991b1b",
        "badge_border": "#fca5a5",
    },
    "amber": {
        "accent": "#b45309",
        "dark_eyebrow": "#fcd34d",
        "badge_bg": "#fef3c7",
        "badge_fg": "#92400e",
        "badge_border": "#fcd34d",
    },
    "slate": {
        "accent": "#334155",
        "dark_eyebrow": "#cbd5e1",
        "badge_bg": "#e2e8f0",
        "badge_fg": "#1e293b",
        "badge_border": "#cbd5e1",
    },
}

AVATAR_PALETTE = [
    ("#dbeafe", "#1e40af"),
    ("#d1fae5", "#065f46"),
    ("#ede9fe", "#5b21b6"),
    ("#fce7f3", "#9d174d"),
    ("#fef3c7", "#92400e"),
    ("#e0f2fe", "#075985"),
]

COLORED_HL_RE = re.compile(r"==(yellow|green|emerald|red|crimson|blue|sky):(.+?)==", re.DOTALL)
DEFAULT_HL_RE = re.compile(r"==(.+?)==", re.DOTALL)
BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)

BASE_CSS = """
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  margin: 0;
  padding: 0;
  width: var(--canvas-width, 1200px);
  background: transparent;
  font-family: 'Lato', 'Noto Sans', 'Liberation Sans', sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#capture-root {
  width: var(--canvas-width, 1200px);
  background: linear-gradient(135deg, #131924 0%, #1d2636 100%);
  padding: 34px;
  display: block;
}
.card {
  width: 100%;
  background: #fdfbf7;
  border-radius: 16px;
  box-shadow: 0 20px 46px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(255, 255, 255, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-top: 8px solid var(--accent, #1d4ed8);
}
.card-dark {
  background: #0f172a;
  color: #f8fafc;
  box-shadow: 0 20px 46px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(148, 163, 184, 0.22);
}
.header {
  padding: 24px 38px 20px 38px;
  background: #f5f1e8;
  border-bottom: 1px solid #e4decb;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
}
.card-dark .header {
  background: #131d33;
  border-bottom: 1px solid #1e293b;
}
.header-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.eyebrow {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 1.35px;
  text-transform: uppercase;
  color: var(--accent, #1d4ed8);
}
.card-dark .eyebrow {
  color: var(--dark-eyebrow, #93c5fd);
}
.doc-title {
  font-size: 25px;
  font-weight: 900;
  color: #111827;
  line-height: 1.22;
}
.card-dark .doc-title {
  color: #f8fafc;
}
.doc-sub {
  font-size: 15px;
  font-weight: 600;
  color: #4b5563;
  line-height: 1.35;
}
.card-dark .doc-sub {
  color: #94a3b8;
}
.badge {
  background: var(--badge-bg, #dbeafe);
  color: var(--badge-fg, #1e40af);
  font-size: 12.5px;
  font-weight: 800;
  padding: 7px 14px;
  border-radius: 999px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  white-space: nowrap;
  border: 1px solid var(--badge-border, #93c5fd);
  flex-shrink: 0;
}
.content {
  padding: 24px 38px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.stats-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.stat-pill {
  background: #ffffff;
  border: 1px solid #e6e1d3;
  border-top: 3px solid var(--accent, #1d4ed8);
  border-radius: 10px;
  padding: 12px 16px;
}
.stat-label {
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.8px;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 4px;
}
.stat-value {
  font-size: 22px;
  font-weight: 900;
  color: #111827;
  line-height: 1.15;
}
.stat-note {
  font-size: 12.5px;
  font-weight: 600;
  color: #4b5563;
  margin-top: 3px;
}
.excerpt-box {
  background: #ffffff;
  border: 1px solid #e6e1d3;
  border-left: 5px solid var(--accent, #1d4ed8);
  border-radius: 10px;
  padding: 18px 24px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03);
}
.section-tag {
  font-size: 12.5px;
  font-weight: 800;
  letter-spacing: 0.85px;
  text-transform: uppercase;
  color: #6b7280;
  margin-bottom: 8px;
}
.quote {
  font-family: 'Noto Serif', 'Liberation Serif', 'DejaVu Serif', Georgia, serif;
  font-size: 19px;
  line-height: 1.54;
  color: #1f2937;
  overflow-wrap: anywhere;
}
mark.hl {
  background: linear-gradient(180deg, rgba(253, 224, 71, 0) 14%, rgba(253, 224, 71, 0.58) 14%, rgba(253, 224, 71, 0.58) 90%, rgba(253, 224, 71, 0) 90%);
  font-weight: 700;
  color: #0f172a;
  padding: 0 2px;
}
mark.hl-green {
  background: linear-gradient(180deg, rgba(134, 239, 172, 0) 14%, rgba(134, 239, 172, 0.55) 14%, rgba(134, 239, 172, 0.55) 90%, rgba(134, 239, 172, 0) 90%);
  color: #064e3b;
}
mark.hl-red {
  background: linear-gradient(180deg, rgba(252, 165, 165, 0) 14%, rgba(252, 165, 165, 0.55) 14%, rgba(252, 165, 165, 0.55) 90%, rgba(252, 165, 165, 0) 90%);
  color: #7f1d1d;
}
mark.hl-blue {
  background: linear-gradient(180deg, rgba(147, 197, 253, 0) 14%, rgba(147, 197, 253, 0.55) 14%, rgba(147, 197, 253, 0.55) 90%, rgba(147, 197, 253, 0) 90%);
  color: #1e3a8a;
}
.card-dark mark.hl {
  background: rgba(250, 204, 21, 0.26);
  color: #fef08a;
  border-radius: 3px;
}
.card-dark mark.hl-green {
  background: rgba(52, 211, 153, 0.25);
  color: #a7f3d0;
  border-radius: 3px;
}
.card-dark mark.hl-red {
  background: rgba(248, 113, 113, 0.26);
  color: #fecaca;
  border-radius: 3px;
}
.card-dark mark.hl-blue {
  background: rgba(96, 165, 250, 0.26);
  color: #bfdbfe;
  border-radius: 3px;
}
/* Social / Post Receipt styles */
.social-surface {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 22px 26px;
}
.card-dark .social-surface {
  background: #162033;
  border: 1px solid #263449;
}
.post-item {
  display: flex;
  gap: 16px;
  position: relative;
}
.post-item + .post-item {
  margin-top: 18px;
}
.avatar-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  width: 46px;
}
.avatar {
  width: 46px;
  height: 46px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 900;
  letter-spacing: 0.4px;
  flex-shrink: 0;
}
.thread-rail {
  width: 2.5px;
  flex: 1;
  min-height: 18px;
  background: #cbd5e1;
  margin-top: 6px;
  margin-bottom: -12px;
  border-radius: 2px;
}
.card-dark .thread-rail {
  background: #334155;
}
.post-main {
  flex: 1;
  min-width: 0;
}
.post-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.author-name {
  font-size: 17.5px;
  font-weight: 900;
  color: #0f172a;
}
.card-dark .author-name {
  color: #f8fafc;
}
.author-handle {
  font-size: 15px;
  font-weight: 600;
  color: #64748b;
}
.card-dark .author-handle {
  color: #94a3b8;
}
.post-dot {
  color: #94a3b8;
  font-size: 14px;
}
.post-date {
  font-size: 14.5px;
  font-weight: 600;
  color: #64748b;
}
.card-dark .post-date {
  color: #94a3b8;
}
.post-body {
  font-family: 'Lato', 'Noto Sans', 'Liberation Sans', sans-serif;
  font-size: 19.5px;
  line-height: 1.48;
  color: #111827;
  overflow-wrap: anywhere;
}
.card-dark .post-body {
  color: #f1f5f9;
}
.post-context-note {
  margin-top: 10px;
  padding: 9px 13px;
  background: #f8fafc;
  border-left: 3px solid var(--accent, #1d4ed8);
  border-radius: 6px;
  font-size: 13.5px;
  font-weight: 600;
  color: #475569;
}
.card-dark .post-context-note {
  background: #0f172a;
  color: #cbd5e1;
}
.footer {
  padding: 14px 38px;
  background: #f5f1e8;
  border-top: 1px solid #e4decb;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  font-size: 13.5px;
  color: #4b5563;
  font-weight: 600;
}
.card-dark .footer {
  background: #131d33;
  border-top: 1px solid #1e293b;
  color: #94a3b8;
}
.footer-source {
  color: #111827;
  font-weight: 800;
}
.card-dark .footer-source {
  color: #e2e8f0;
}
"""


class CardSpecError(ValueError):
    """Raised when a card specification is invalid or incomplete."""


def find_browser_binary() -> str:
    """Discover a local headless Chromium / Chrome executable."""
    env_bin = os.environ.get("BSKY_CARD_BROWSER")
    if env_bin and os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):
        return env_bin

    candidates: list[str] = []
    for cmd in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        resolved = shutil.which(cmd)
        if resolved:
            candidates.append(resolved)

    home = Path.home()
    candidates.extend(
        sorted(
            glob.glob(str(home / ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")),
            reverse=True,
        )
    )
    candidates.extend(
        sorted(
            glob.glob(str(home / ".cache/ms-playwright/chromium-*/chrome-linux64/chrome")),
            reverse=True,
        )
    )

    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    raise RuntimeError(
        "No headless Chromium/Chrome binary found. Set BSKY_CARD_BROWSER or install Chromium / Playwright chromium."
    )


def format_verbatim_markup(raw_text: str) -> str:
    """HTML-escape untrusted verbatim text first, then apply safe highlight/bold markers."""
    escaped = html.escape(str(raw_text), quote=True)

    def _replace_colored(match: re.Match[str]) -> str:
        tone = match.group(1).lower()
        body = match.group(2)
        if tone in ("green", "emerald"):
            cls = "hl hl-green"
        elif tone in ("red", "crimson"):
            cls = "hl hl-red"
        elif tone in ("blue", "sky"):
            cls = "hl hl-blue"
        else:
            cls = "hl"
        return f'<mark class="{cls}">{body}</mark>'

    formatted = COLORED_HL_RE.sub(_replace_colored, escaped)
    formatted = DEFAULT_HL_RE.sub(r'<mark class="hl">\1</mark>', formatted)
    formatted = BOLD_RE.sub(r"<strong>\1</strong>", formatted)
    formatted = formatted.replace("\r\n", "\n").replace("\n", "<br>")
    return formatted


def strip_markup(raw_text: str) -> str:
    """Strip inline highlight/bold markers into clean plain text for accessible alt text."""
    text = COLORED_HL_RE.sub(r"\2", str(raw_text))
    text = DEFAULT_HL_RE.sub(r"\1", text)
    text = BOLD_RE.sub(r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def truncate_alt(text: str, max_chars: int = 950) -> str:
    """Keep auto-generated alt text concise and well below Bluesky's 1000-char ceiling."""
    cleaned = re.sub(r"\s+", " ", text).strip()
    if len(cleaned) <= max_chars:
        return cleaned
    cut = cleaned[: max_chars - 3].rsplit(" ", 1)[0]
    return f"{cut}..."


def compute_initials(name: str, handle: str = "") -> str:
    """Extract 1-2 uppercase initials for social card avatars."""
    words = [w for w in re.split(r"[\s._-]+", name.strip()) if any(ch.isalnum() for ch in w)]
    if len(words) >= 2:
        first = next(ch for ch in words[0] if ch.isalnum())
        second = next(ch for ch in words[1] if ch.isalnum())
        return (first + second).upper()
    if len(words) == 1:
        alnum = [ch for ch in words[0] if ch.isalnum()]
        return "".join(alnum[:2]).upper()
    fallback = [ch for ch in handle.lstrip("@") if ch.isalnum()]
    return ("".join(fallback[:2]) or "OP").upper()


def normalize_handle(handle: str) -> str:
    h = handle.strip()
    if not h:
        return ""
    return h if h.startswith("@") else f"@{h}"


def resolve_theme(card: dict[str, Any]) -> dict[str, str]:
    theme_name = str(card.get("theme") or "blue").strip().lower()
    base = dict(THEMES.get(theme_name, THEMES["blue"]))
    for key in ("accent", "badge_bg", "badge_fg", "badge_border"):
        if card.get(key):
            base[key] = str(card[key]).strip()
    return base


def normalize_card_type(raw_type: Any) -> str:
    t = str(raw_type or "document").strip().lower()
    if t in ("document", "excerpt", "filing"):
        return "document"
    if t in ("post", "social", "quote_chain"):
        return "post"
    raise CardSpecError(
        f"Unsupported card type '{raw_type}'. Expected 'document' (or 'excerpt'/'filing') or 'post' (or 'social')."
    )


def build_document_card_html_and_alt(card: dict[str, Any], width: int) -> tuple[str, str]:
    theme = resolve_theme(card)
    title = str(card.get("title") or "").strip()
    if not title:
        raise CardSpecError("Document card requires a non-empty 'title'.")

    eyebrow = str(card.get("eyebrow") or card.get("kicker") or "Primary Source Excerpt").strip()
    subtitle = str(card.get("subtitle") or card.get("sub") or "").strip()
    badge = str(card.get("badge") or card.get("date") or "").strip()
    footer_left = str(card.get("footer_left") or card.get("source") or "").strip()
    footer_right = str(card.get("footer_right") or "Verbatim Excerpt").strip()

    raw_boxes = card.get("boxes")
    boxes: list[tuple[str, str]] = []
    if isinstance(raw_boxes, list) and raw_boxes:
        for idx, item in enumerate(raw_boxes):
            if isinstance(item, (list, tuple)) and len(item) == 2:
                label, quote = str(item[0]).strip(), str(item[1]).strip()
            elif isinstance(item, dict):
                label = str(item.get("label") or item.get("section") or item.get("heading") or "").strip()
                quote = str(item.get("quote") or item.get("text") or "").strip()
            else:
                raise CardSpecError(f"Document card boxes[{idx}] must be an object {{label, quote}} or [label, quote] pair.")
            if not quote:
                raise CardSpecError(f"Document card boxes[{idx}] has an empty quote.")
            boxes.append((label, quote))
    elif card.get("quote") or card.get("text"):
        boxes.append(
            (
                str(card.get("section") or card.get("label") or "").strip(),
                str(card.get("quote") or card.get("text") or "").strip(),
            )
        )
    else:
        raise CardSpecError("Document card requires either non-empty 'boxes' or a top-level 'quote'.")

    raw_stats = card.get("stats") or []
    stats_html = ""
    stats_alt_parts: list[str] = []
    if isinstance(raw_stats, list) and raw_stats:
        pills: list[str] = []
        for s in raw_stats:
            if not isinstance(s, dict) or not s.get("label") or s.get("value") is None:
                raise CardSpecError("Each item in 'stats' must be an object with 'label' and 'value'.")
            s_label = str(s["label"]).strip()
            s_val = str(s["value"]).strip()
            s_note = str(s.get("note") or "").strip()
            note_html = f'<div class="stat-note">{html.escape(s_note)}</div>' if s_note else ""
            pills.append(
                f'<div class="stat-pill">'
                f'<div class="stat-label">{html.escape(s_label)}</div>'
                f'<div class="stat-value">{html.escape(s_val)}</div>'
                f"{note_html}</div>"
            )
            stats_alt_parts.append(f"{s_label}: {s_val}" + (f" ({s_note})" if s_note else ""))
        stats_html = f'<div class="stats-strip">{"".join(pills)}</div>'

    boxes_html_parts: list[str] = []
    alt_quote_parts: list[str] = []
    for label, quote in boxes:
        tag_html = f'<div class="section-tag">{html.escape(label)}</div>' if label else ""
        boxes_html_parts.append(
            f'<div class="excerpt-box">{tag_html}<div class="quote">{format_verbatim_markup(quote)}</div></div>'
        )
        plain_q = strip_markup(quote)
        alt_quote_parts.append(f"{label}: {plain_q}" if label else plain_q)

    sub_html = f'<div class="doc-sub">{html.escape(subtitle)}</div>' if subtitle else ""
    badge_html = f'<div class="badge">{html.escape(badge)}</div>' if badge else ""
    footer_html = ""
    if footer_left or footer_right:
        footer_html = (
            f'<div class="footer">'
            f'<div class="footer-source">{html.escape(footer_left)}</div>'
            f"<div>{html.escape(footer_right)}</div>"
            f"</div>"
        )

    doc_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
:root {{
  --canvas-width: {width}px;
  --accent: {html.escape(theme["accent"])};
  --badge-bg: {html.escape(theme["badge_bg"])};
  --badge-fg: {html.escape(theme["badge_fg"])};
  --badge-border: {html.escape(theme["badge_border"])};
}}
{BASE_CSS}
</style>
</head>
<body>
  <div id="capture-root">
    <div class="card">
      <div class="header">
        <div class="header-left">
          <div class="eyebrow">{html.escape(eyebrow)}</div>
          <div class="doc-title">{html.escape(title)}</div>
          {sub_html}
        </div>
        {badge_html}
      </div>
      <div class="content">
        {stats_html}
        {"".join(boxes_html_parts)}
      </div>
      {footer_html}
    </div>
  </div>
</body>
</html>"""

    explicit_alt = str(card.get("alt") or "").strip()
    if explicit_alt:
        alt_text = explicit_alt
    else:
        header_summary = f"{eyebrow}: {title}" + (f" ({badge})" if badge else "")
        pieces = [f"Document excerpt card: {header_summary}."]
        if stats_alt_parts:
            pieces.append("Key figures: " + "; ".join(stats_alt_parts) + ".")
        pieces.append(" ".join(alt_quote_parts))
        if footer_left:
            pieces.append(f"({footer_left})")
        alt_text = truncate_alt(" ".join(pieces))

    return doc_html, alt_text


def build_post_card_html_and_alt(card: dict[str, Any], width: int) -> tuple[str, str]:
    theme = resolve_theme(card)
    surface = str(card.get("surface") or card.get("variant") or "light").strip().lower()
    dark_cls = " card-dark" if surface == "dark" else ""

    eyebrow = str(card.get("eyebrow") or "").strip()
    title = str(card.get("title") or "").strip()
    subtitle = str(card.get("subtitle") or card.get("sub") or "").strip()
    badge = str(card.get("badge") or card.get("platform") or "").strip()
    footer_left = str(card.get("footer_left") or card.get("source") or "").strip()
    footer_right = str(card.get("footer_right") or "").strip()

    raw_posts = card.get("posts")
    posts: list[dict[str, str]] = []
    if isinstance(raw_posts, list) and raw_posts:
        for idx, item in enumerate(raw_posts):
            if not isinstance(item, dict):
                raise CardSpecError(f"Post card posts[{idx}] must be an object.")
            text = str(item.get("text") or item.get("quote") or "").strip()
            if not text:
                raise CardSpecError(f"Post card posts[{idx}] requires non-empty 'text'.")
            name = str(item.get("name") or item.get("author_name") or item.get("author") or "").strip()
            handle = normalize_handle(str(item.get("handle") or ""))
            if not name and not handle:
                raise CardSpecError(f"Post card posts[{idx}] requires 'name' or 'handle'.")
            posts.append(
                {
                    "name": name or handle,
                    "handle": handle,
                    "date": str(item.get("date") or item.get("timestamp") or "").strip(),
                    "text": text,
                    "note": str(item.get("note") or "").strip(),
                }
            )
    elif card.get("quote") or card.get("text"):
        name = str(card.get("author_name") or card.get("name") or card.get("author") or "").strip()
        handle = normalize_handle(str(card.get("handle") or ""))
        if not name and not handle:
            raise CardSpecError("Single-post card requires 'author_name'/'name' or 'handle'.")
        posts.append(
            {
                "name": name or handle,
                "handle": handle,
                "date": str(card.get("date") or card.get("timestamp") or "").strip(),
                "text": str(card.get("quote") or card.get("text") or "").strip(),
                "note": str(card.get("note") or "").strip(),
            }
        )
    else:
        raise CardSpecError("Post card requires either non-empty 'posts' list or top-level 'text'/'quote'.")

    header_html = ""
    if eyebrow or title or subtitle or badge:
        eyebrow_html = f'<div class="eyebrow">{html.escape(eyebrow)}</div>' if eyebrow else ""
        title_html = f'<div class="doc-title">{html.escape(title)}</div>' if title else ""
        sub_html = f'<div class="doc-sub">{html.escape(subtitle)}</div>' if subtitle else ""
        badge_html = f'<div class="badge">{html.escape(badge)}</div>' if badge else ""
        header_html = (
            f'<div class="header">'
            f'<div class="header-left">{eyebrow_html}{title_html}{sub_html}</div>'
            f"{badge_html}</div>"
        )

    post_items_html: list[str] = []
    alt_post_parts: list[str] = []
    for idx, p in enumerate(posts):
        is_last = idx == len(posts) - 1
        initials = compute_initials(p["name"], p["handle"])
        bg_hex, fg_hex = AVATAR_PALETTE[sum(ord(c) for c in (p["handle"] or p["name"])) % len(AVATAR_PALETTE)]
        rail_html = "" if is_last else '<div class="thread-rail"></div>'

        meta_bits = [f'<span class="author-name">{html.escape(p["name"])}</span>']
        if p["handle"] and p["handle"] != p["name"]:
            meta_bits.append(f'<span class="author-handle">{html.escape(p["handle"])}</span>')
        if p["date"]:
            meta_bits.append('<span class="post-dot">&bull;</span>')
            meta_bits.append(f'<span class="post-date">{html.escape(p["date"])}</span>')

        note_html = f'<div class="post-context-note">{format_verbatim_markup(p["note"])}</div>' if p["note"] else ""
        post_items_html.append(
            f'<div class="post-item">'
            f'<div class="avatar-col">'
            f'<div class="avatar" style="background:{bg_hex};color:{fg_hex};">{html.escape(initials)}</div>'
            f"{rail_html}"
            f"</div>"
            f'<div class="post-main">'
            f'<div class="post-meta">{"".join(meta_bits)}</div>'
            f'<div class="post-body">{format_verbatim_markup(p["text"])}</div>'
            f"{note_html}"
            f"</div>"
            f"</div>"
        )

        who = f"{p['name']} ({p['handle']})" if p["handle"] and p["handle"] != p["name"] else p["name"]
        when = f" on {p['date']}" if p["date"] else ""
        alt_post_parts.append(f'{who}{when}: "{strip_markup(p["text"])}"')

    footer_html = ""
    if footer_left or footer_right:
        footer_html = (
            f'<div class="footer">'
            f'<div class="footer-source">{html.escape(footer_left)}</div>'
            f"<div>{html.escape(footer_right)}</div>"
            f"</div>"
        )

    post_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
:root {{
  --canvas-width: {width}px;
  --accent: {html.escape(theme["accent"])};
  --dark-eyebrow: {html.escape(theme["dark_eyebrow"])};
  --badge-bg: {html.escape(theme["badge_bg"])};
  --badge-fg: {html.escape(theme["badge_fg"])};
  --badge-border: {html.escape(theme["badge_border"])};
}}
{BASE_CSS}
</style>
</head>
<body>
  <div id="capture-root">
    <div class="card{dark_cls}">
      {header_html}
      <div class="content">
        <div class="social-surface">
          {"".join(post_items_html)}
        </div>
      </div>
      {footer_html}
    </div>
  </div>
</body>
</html>"""

    explicit_alt = str(card.get("alt") or "").strip()
    if explicit_alt:
        alt_text = explicit_alt
    else:
        prefix = f"Social post receipt ({title}): " if title else "Social post receipt: "
        alt_text = truncate_alt(prefix + " / ".join(alt_post_parts))

    return post_html, alt_text


def parse_png_dimensions(png_bytes: bytes) -> tuple[int, int]:
    """Independently verify PNG signature and read IHDR pixel dimensions."""
    if len(png_bytes) < 24 or png_bytes[:8] != b"\x89PNG\r\n\x1a\n" or png_bytes[12:16] != b"IHDR":
        raise RuntimeError("Rendered output is not a valid PNG image.")
    width, height = struct.unpack(">II", png_bytes[16:24])
    return int(width), int(height)


class LocalCDPClient:
    """Minimal RFC 6455 localhost WebSocket client for Chromium DevTools Protocol."""

    def __init__(self, ws_url: str, timeout: float = 15.0) -> None:
        m = re.match(r"^ws://([^/:]+):(\d+)(/.*)$", ws_url)
        if not m:
            raise ValueError(f"Invalid CDP WebSocket URL: {ws_url}")
        host, port_str, path = m.group(1), m.group(2), m.group(3)
        self.sock = socket.create_connection((host, int(port_str)), timeout=timeout)
        self._buf = bytearray()
        self._next_id = 1

        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port_str}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode("ascii"))
        while b"\r\n\r\n" not in self._buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP WebSocket handshake closed unexpectedly.")
            self._buf.extend(chunk)
        header_end = self._buf.index(b"\r\n\r\n") + 4
        status_line = bytes(self._buf[:header_end]).splitlines()[0].decode("latin1", errors="replace")
        if "101" not in status_line:
            raise RuntimeError(f"CDP WebSocket handshake failed: {status_line}")
        del self._buf[:header_end]

    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self._buf)))
            if not chunk:
                raise RuntimeError("CDP WebSocket connection closed mid-frame.")
            self._buf.extend(chunk)
        out = bytes(self._buf[:n])
        del self._buf[:n]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask_key = os.urandom(4)
        header = bytearray([0x80 | (opcode & 0x0F)])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", n))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", n))
        header.extend(mask_key)
        masked = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _recv_message(self) -> str:
        fragments: list[bytes] = []
        while True:
            b0, b1 = self._recv_exact(2)
            fin = bool(b0 & 0x80)
            opcode = b0 & 0x0F
            masked = bool(b1 & 0x80)
            length = b1 & 0x7F
            if length == 126:
                (length,) = struct.unpack("!H", self._recv_exact(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", self._recv_exact(8))
            mask_key = self._recv_exact(4) if masked else b""
            payload = self._recv_exact(length)
            if masked:
                payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))

            if opcode == 0x9:  # Ping -> Pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0x8:  # Close
                raise RuntimeError("CDP WebSocket closed by browser.")
            if opcode in (0x1, 0x2, 0x0):
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8")

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        call_id = self._next_id
        self._next_id += 1
        msg = json.dumps({"id": call_id, "method": method, "params": params or {}})
        self._send_frame(0x1, msg.encode("utf-8"))
        while True:
            raw = self._recv_message()
            data = json.loads(raw)
            if data.get("id") == call_id:
                if "error" in data:
                    raise RuntimeError(f"CDP error in {method}: {data['error']}")
                return data.get("result", {})

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def render_html_batch_cdp(
    browser_bin: str,
    jobs: list[tuple[str, Path, int, float]],
) -> list[tuple[int, int]]:
    """Render all HTML documents in one headless Chromium CDP session with exact DOM bounding-box clips."""
    proc = subprocess.Popen(
        [
            browser_bin,
            "--headless",
            "--no-sandbox",
            "--disable-gpu",
            "--disable-dev-shm-usage",
            "--hide-scrollbars",
            "--remote-debugging-port=0",
            "about:blank",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    cdp: LocalCDPClient | None = None
    try:
        deadline = time.monotonic() + 10.0
        port: int | None = None
        assert proc.stderr is not None
        while time.monotonic() < deadline:
            line = proc.stderr.readline()
            if not line and proc.poll() is not None:
                break
            m = re.search(r"ws://127\.0\.0\.1:(\d+)/devtools/browser/\S+", line)
            if m:
                port = int(m.group(1))
                break
        if port is None:
            raise RuntimeError("Timed out waiting for headless Chromium CDP port.")

        targets = json.loads(
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5.0).read().decode("utf-8")
        )
        page_targets = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
        if not page_targets:
            raise RuntimeError("No debuggable page target exposed by headless Chromium.")

        cdp = LocalCDPClient(page_targets[0]["webSocketDebuggerUrl"])
        cdp.call("Page.enable")
        cdp.call("Runtime.enable")
        frame_id = cdp.call("Page.getFrameTree")["frameTree"]["frame"]["id"]

        dimensions: list[tuple[int, int]] = []
        for html_doc, out_path, css_width, scale in jobs:
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": css_width,
                    "height": 600,
                    "deviceScaleFactor": scale,
                    "mobile": False,
                },
            )
            cdp.call("Page.setDocumentContent", {"frameId": frame_id, "html": html_doc})
            eval_res = cdp.call(
                "Runtime.evaluate",
                {
                    "expression": """
                    (async () => {
                      if (document.fonts && document.fonts.ready) {
                        await document.fonts.ready;
                      }
                      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                      const el = document.getElementById('capture-root');
                      const rect = el.getBoundingClientRect();
                      return {
                        width: Math.ceil(rect.width),
                        height: Math.ceil(rect.height)
                      };
                    })()
                    """,
                    "awaitPromise": True,
                    "returnByValue": True,
                },
            )
            box = eval_res["result"]["value"]
            box_w = max(1, int(box["width"]))
            box_h = max(1, int(box["height"]))

            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": box_w,
                    "height": box_h,
                    "deviceScaleFactor": scale,
                    "mobile": False,
                },
            )
            shot = cdp.call(
                "Page.captureScreenshot",
                {
                    "format": "png",
                    "clip": {"x": 0, "y": 0, "width": box_w, "height": box_h, "scale": 1},
                    "captureBeyondViewport": True,
                },
            )
            png_bytes = base64.b64decode(shot["data"])
            px_w, px_h = parse_png_dimensions(png_bytes)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(png_bytes)
            dimensions.append((px_w, px_h))

        return dimensions
    finally:
        if cdp is not None:
            cdp.close()
        proc.terminate()
        try:
            proc.wait(timeout=3.0)
        except subprocess.TimeoutExpired:
            proc.kill()


def render_html_batch_cli_fallback(
    browser_bin: str,
    jobs: list[tuple[str, Path, int, float]],
) -> list[tuple[int, int]]:
    """Fallback renderer using one-shot `--screenshot` if localhost sockets are unavailable."""
    dimensions: list[tuple[int, int]] = []
    with tempfile.TemporaryDirectory(prefix="bsky-card-") as tmp:
        for idx, (html_doc, out_path, css_width, scale) in enumerate(jobs):
            html_file = Path(tmp) / f"card_{idx}.html"
            html_file.write_text(html_doc, encoding="utf-8")
            out_path.parent.mkdir(parents=True, exist_ok=True)
            est_height = max(520, min(1800, 320 + (len(html_doc) // 9)))
            cmd = [
                browser_bin,
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                f"--force-device-scale-factor={scale}",
                f"--window-size={css_width},{est_height}",
                f"--screenshot={out_path}",
                f"file://{html_file}",
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            px_w, px_h = parse_png_dimensions(out_path.read_bytes())
            dimensions.append((px_w, px_h))
    return dimensions


def render_cards(
    cards: list[dict[str, Any]],
    out_dir: Path,
    default_width: int = 1200,
    default_scale: float = 2.0,
    save_html: bool = False,
) -> dict[str, Any]:
    """Validate specs, render all cards to PNG, and return a `draft.json`-ready manifest."""
    if not cards:
        raise CardSpecError("No cards provided to render.")

    browser_bin = find_browser_binary()
    out_dir.mkdir(parents=True, exist_ok=True)

    prepared: list[tuple[int, str, str, Path, int, float]] = []
    for idx, card in enumerate(cards):
        if not isinstance(card, dict):
            raise CardSpecError(f"Card #{idx + 1} must be a JSON object.")
        card_type = normalize_card_type(card.get("type"))
        width = int(card.get("width") or default_width)
        scale = float(card.get("scale") or default_scale)
        if width < 320 or width > 2400:
            raise CardSpecError(f"Card #{idx + 1} width {width} out of range [320, 2400].")
        if scale <= 0 or scale > 4:
            raise CardSpecError(f"Card #{idx + 1} scale {scale} out of range (0, 4].")

        if card_type == "document":
            html_doc, alt_text = build_document_card_html_and_alt(card, width)
        else:
            html_doc, alt_text = build_post_card_html_and_alt(card, width)

        raw_out = str(card.get("output") or card.get("filename") or f"card_{idx + 1}.png").strip()
        out_path = Path(raw_out)
        if not out_path.is_absolute():
            out_path = (out_dir / out_path).resolve()
        else:
            out_path = out_path.resolve()

        if save_html:
            html_path = out_path.with_suffix(".html")
            html_path.parent.mkdir(parents=True, exist_ok=True)
            html_path.write_text(html_doc, encoding="utf-8")

        prepared.append((idx, card_type, alt_text, out_path, width, scale))
        # Store generated HTML alongside job list
        card["_rendered_html"] = html_doc

    jobs = [(str(cards[idx]["_rendered_html"]), out_path, width, scale) for idx, _, _, out_path, width, scale in prepared]
    for c in cards:
        c.pop("_rendered_html", None)

    t0 = time.monotonic()
    try:
        dims = render_html_batch_cdp(browser_bin, jobs)
        engine = "cdp"
    except Exception:
        dims = render_html_batch_cli_fallback(browser_bin, jobs)
        engine = "cli-fallback"
    elapsed_ms = round((time.monotonic() - t0) * 1000, 1)

    manifest_cards: list[dict[str, Any]] = []
    image_paths: list[str] = []
    image_alts: list[str] = []
    for (idx, card_type, alt_text, out_path, _, _), (px_w, px_h) in zip(prepared, dims):
        size_bytes = out_path.stat().st_size
        image_paths.append(str(out_path))
        image_alts.append(alt_text)
        manifest_cards.append(
            {
                "index": idx + 1,
                "type": card_type,
                "imagePath": str(out_path),
                "imageAlt": alt_text,
                "width": px_w,
                "height": px_h,
                "bytes": size_bytes,
            }
        )

    return {
        "engine": engine,
        "elapsedMs": elapsed_ms,
        "count": len(manifest_cards),
        "imagePaths": image_paths,
        "imageAlts": image_alts,
        "cards": manifest_cards,
    }


def parse_cli_card(args: argparse.Namespace) -> dict[str, Any]:
    """Construct a single-card dict from direct CLI flags."""
    card: dict[str, Any] = {
        "type": args.type,
        "theme": args.theme,
        "surface": args.surface,
    }
    for field in ("eyebrow", "title", "subtitle", "badge", "footer_left", "footer_right", "alt", "output"):
        val = getattr(args, field, None)
        if val:
            card[field] = val

    if normalize_card_type(args.type) == "document":
        boxes: list[dict[str, str]] = []
        if args.box:
            for raw_box in args.box:
                if "::" in raw_box:
                    label, quote = raw_box.split("::", 1)
                    boxes.append({"label": label.strip(), "quote": quote.strip()})
                else:
                    boxes.append({"label": "", "quote": raw_box.strip()})
        if args.quote:
            boxes.append({"label": args.section or "", "quote": args.quote})
        if boxes:
            card["boxes"] = boxes
    else:
        posts: list[dict[str, str]] = []
        if args.post:
            for raw_post in args.post:
                parts = raw_post.split("|", 3)
                if len(parts) != 4:
                    raise CardSpecError(
                        "Each --post flag must have 4 pipe-separated fields: 'Name|@handle|Date|Verbatim post text'."
                    )
                posts.append(
                    {
                        "name": parts[0].strip(),
                        "handle": parts[1].strip(),
                        "date": parts[2].strip(),
                        "text": parts[3].strip(),
                    }
                )
        if args.quote:
            posts.append(
                {
                    "name": args.author_name or "",
                    "handle": args.handle or "",
                    "date": args.date or "",
                    "text": args.quote,
                }
            )
        if posts:
            card["posts"] = posts

    return card


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Render tightly cropped Retina PNG receipt cards for Bluesky threads (batch JSON or single-card CLI)."
    )
    p.add_argument("spec", nargs="?", help="Optional path to JSON card spec file (array of cards or {'cards': [...]}).")
    p.add_argument("--out-dir", default=".", help="Output directory for rendered PNGs (default: current directory).")
    p.add_argument("--manifest", help="Optional path to save output JSON manifest (`imagePaths` + `imageAlts`).")
    p.add_argument("--width", type=int, default=1200, help="Card CSS canvas width in px before 2x scale (default: 1200).")
    p.add_argument("--scale", type=float, default=2.0, help="Device scale factor (default: 2.0 -> 2400px Retina PNG).")
    p.add_argument("--save-html", action="store_true", help="Also write intermediate .html files next to PNGs.")

    # Single-card CLI options
    p.add_argument("--type", default="document", help="Single-card mode type: 'document' or 'post'.")
    p.add_argument("--theme", default="blue", help="Color theme: blue, emerald, sky, crimson, amber, slate.")
    p.add_argument("--surface", default="light", choices=["light", "dark"], help="Surface variant for 'post' cards.")
    p.add_argument("--eyebrow", help="Header eyebrow / source category.")
    p.add_argument("--title", help="Card headline / document title.")
    p.add_argument("--subtitle", help="Card subtitle / citation detail.")
    p.add_argument("--badge", help="Top-right pill text (e.g. date or roll call number).")
    p.add_argument("--section", help="Section tag for single-box --quote.")
    p.add_argument("--quote", help="Verbatim quote/body text (supports ==highlight==, ==green:...==, ==red:...==, **bold**).")
    p.add_argument("--box", action="append", help="Repeatable document box 'Section Label::Verbatim quote text'.")
    p.add_argument("--author-name", help="Author display name for single --type post card.")
    p.add_argument("--handle", help="Author @handle for single --type post card.")
    p.add_argument("--date", help="Timestamp string for single --type post card.")
    p.add_argument("--post", action="append", help="Repeatable post item 'Display Name|@handle|Date|Verbatim post text'.")
    p.add_argument("--footer-left", help="Primary source citation in footer left.")
    p.add_argument("--footer-right", help="Footer right label (e.g. 'Verbatim Excerpt (1 of 2)').")
    p.add_argument("--alt", help="Explicit Bluesky imageAlt override (auto-generated if omitted).")
    p.add_argument("-o", "--output", help="Output PNG filename or path for single-card mode.")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        if args.spec:
            spec_path = Path(args.spec)
            if not spec_path.is_file():
                raise CardSpecError(f"Spec file not found: {spec_path}")
            try:
                loaded = json.loads(spec_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise CardSpecError(f"Invalid JSON in {spec_path}: {exc}") from exc

            if isinstance(loaded, list):
                cards = loaded
            elif isinstance(loaded, dict) and isinstance(loaded.get("cards"), list):
                cards = loaded["cards"]
            elif isinstance(loaded, dict):
                cards = [loaded]
            else:
                raise CardSpecError("JSON spec must be an object or array of card objects.")
        else:
            cards = [parse_cli_card(args)]

        manifest = render_cards(
            cards=cards,
            out_dir=Path(args.out_dir),
            default_width=args.width,
            default_scale=args.scale,
            save_html=args.save_html,
        )
        if args.manifest:
            manifest_path = Path(args.manifest)
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

        print(json.dumps(manifest, indent=2))
        return 0
    except (CardSpecError, RuntimeError) as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
