#!/usr/bin/env python3
"""Real-testing regression replays and seeded systematic exploration for bsky-threadcraft scripts."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "skills" / "bsky-threadcraft" / "scripts"
SAMPLER_PY = SCRIPTS_DIR / "sample_mike_posts.py"
AISIGNS_PY = SCRIPTS_DIR / "fetch_aisigns_digest.py"
LINTER_PY = SCRIPTS_DIR / "lint_thread.py"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_r1_aisigns_self_closing_ref_and_nested_cot_regression() -> None:
    """Regression replay: self-closing <ref name='x' /> before <ref>...</ref> and nested {{diff}} inside {{cot}}...{{cob}} must not swallow H2 sections."""
    aisigns = load_module("aisigns", AISIGNS_PY)
    fixture_wikitext = """
==Content==
===Superficial analyses===
{{tmbox|image=none|text=Words to watch: {{strong|''highlighting'', ''underscoring''}}}}
AI chatbots attach trailing participial clauses.<ref name="selfclosing1" /> This happens frequently.<ref name="full1">{{Cite web|title=Study}}</ref>
{{cot|bg=#ffffff|From {{diff||12345|label=nested template inside cot}}}}
Example text that should be stripped cleanly.
{{cob}}

==Language and grammar==
=== High density of "AI vocabulary" words ===
{{tmbox|image=none|text=Words to watch: {{strong|''delve'',<ref name="unclosed_quote /> ''tapestry'',<ref name="r2" /> ''pivotal''}}}}
* '''2023 to mid-2024''' (GPT-4): ''delve'', ''tapestry'', ''underscore''

== Edit summaries ==
=== Reference to AfC review ===
Wikipedia internal procedural text that should be excluded from thread digest.

== Historical indicators ==
===Overuse of em dashes (2022–September 2026)===
LLMs overuse em dashes (—) where humans use commas or colons.<ref name="merrill">{{cite news|title=Em dash}}</ref>
"""
    digest_md, rules = aisigns.distill_wikitext(fixture_wikitext, 999999, "2026-11-10T00:00:00Z")
    assert "## Content" in digest_md, f"Swallowed ## Content:\n{digest_md}"
    assert "### Superficial analyses" in digest_md
    assert "## Language and grammar" in digest_md, f"Swallowed ## Language and grammar:\n{digest_md}"
    assert "## Historical indicators" in digest_md, f"Swallowed ## Historical indicators:\n{digest_md}"
    assert "Edit summaries" not in digest_md, "Wikipedia-only section leaked into digest"
    assert "Example text that should be stripped" not in digest_md, "{{cot}} block leaked into digest"
    assert "<ref " not in digest_md and "</ref>" not in digest_md and "{{cite" not in digest_md.lower()
    assert "2023 to mid-2024" not in rules["ai_vocabulary"], "Era header leaked into ai_vocabulary list"
    for w in ("delve", "tapestry", "pivotal", "underscore"):
        assert w in rules["ai_vocabulary"], f"Missing watchword {w}"


def test_r2_sampler_excludes_bot_ping_and_bare_urls_while_reconstructing_threads() -> None:
    """Regression replay: @handle-only bot-ping chains and bare URLs must be filtered out while substantive self-threads are reconstructed."""
    sampler = load_module("sampler", SAMPLER_PY)
    did = sampler.DEFAULT_DID

    assert sampler.prose_length("@skywalker-bot.bsky.social hello!") < 35
    assert sampler.prose_length("https://bsky.app/profile/mike10010100.bsky.social/post/3jz26ak7hno2w") == 0
    assert sampler.prose_length("apnews.com/article/china-divestment-12345") == 0

    # Verify live/cached CLI execution across modes
    with tempfile.TemporaryDirectory() as tmp:
        out_exp = Path(tmp) / "exp.txt"
        out_rep = Path(tmp) / "rep.txt"
        r1 = subprocess.run(
            [sys.executable, str(SAMPLER_PY), "--mode", "explainer", "--count", "40", "--seed", "7", "-o", str(out_exp)],
            capture_output=True,
            text=True,
            check=True,
        )
        r2 = subprocess.run(
            [sys.executable, str(SAMPLER_PY), "--mode", "reply", "--count", "40", "--seed", "7", "-o", str(out_rep)],
            capture_output=True,
            text=True,
            check=True,
        )
        exp_txt = out_exp.read_text(encoding="utf-8")
        rep_txt = out_rep.read_text(encoding="utf-8")
        assert "@skywalker-bot.bsky.social hello!" not in exp_txt
        assert "SELF-THREAD]" in exp_txt and "[Post 1/" in exp_txt
        assert exp_txt.count("SELF-THREAD]") > rep_txt.count("SELF-THREAD]")
        assert rep_txt.count("REPLY]") > exp_txt.count("REPLY]")
        assert len(exp_txt.encode("utf-8")) < 40_000, "Output must fit cleanly inside single 46KB read_file limit"


def test_s3_linter_cli_contracts() -> None:
    """Direct CLI acceptance & rejection contracts on lint_thread.py."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)

        # 1. Clean realistic 3-post thread with proper-noun list ("Pelosi, Stevens, and Correa") + URL containing '--' and 'highlight'
        img_file = tmp_dir / "card.png"
        img_file.write_bytes(b"\x89PNG\r\n\x1a\n")

        clean_payload = {
            "replyTo": "https://bsky.app/profile/pwt75.bsky.social/post/3mzyumxyz",
            "posts": [
                {
                    "text": "People are mad 11 House Democrats missed Tuesday's 211-204 procedural vote on Pete Hegseth's impeachment.\n\nLook at the actual floor math: even 100% Dem attendance could not pass it.",
                    "imagePaths": [str(img_file)],
                    "imageAlts": ["House Clerk Roll Call 317 tally table showing 211 Yea and 204 Nay"],
                },
                {
                    "text": "Pelosi, Stevens, and Correa missed all three Tuesday roll calls. Check https://example.com/roll-call--highlight/2026317 for the full Clerk XML.",
                },
                {
                    "text": "Be mad at members missing votes if you want. Just stop pretending Jeffries blew a real shot to impeach Hegseth in a GOP-run lame duck.",
                },
            ],
        }
        clean_json = tmp_dir / "clean.json"
        clean_json.write_text(json.dumps(clean_payload), encoding="utf-8")
        res_clean = subprocess.run(
            [sys.executable, str(LINTER_PY), "--strict", "--mode", "explainer", str(clean_json)],
            capture_output=True,
            text=True,
        )
        assert res_clean.returncode == 0, f"Clean thread failed strict lint:\n{res_clean.stdout}\n{res_clean.stderr}"
        assert "ALL HARD GATES & WP:AISIGNS CHECKS PASSED CLEANLY" in res_clean.stdout

        # 2. Hard gate failures: 301 graphemes, em dash, prose '--', emoji, missing imageAlts, bad key 'replyToUri'
        bad_payload = {
            "replyToUri": "https://bsky.app/profile/test/post/123",
            "posts": [
                {"text": "a" * 301},
                {"text": "Em dash — and prose -- and spool 🧵"},
                {"text": "Image missing alt", "imagePaths": [str(img_file)]},
            ],
        }
        bad_json = tmp_dir / "bad.json"
        bad_json.write_text(json.dumps(bad_payload), encoding="utf-8")
        res_bad = subprocess.run(
            [sys.executable, str(LINTER_PY), str(bad_json)],
            capture_output=True,
            text=True,
        )
        assert res_bad.returncode == 1
        assert "EXCEEDS 300 GRAPHEMES by +1 (301/300)" in res_bad.stdout
        assert "em dash" in res_bad.stdout
        assert "double-hyphen" in res_bad.stdout
        assert "emoji" in res_bad.stdout
        assert "imageAlts" in res_bad.stdout
        assert "replyToUri" in res_bad.stdout

        # 3. WP:AISIGNS advisories (exit 0 default, exit 2 under --strict)
        adv_payload = [
            "TBF, this serves as a pivotal testament to housing, healthcare, and labor, underscoring the stakes. It's not just policy, it's power."
        ]
        adv_json = tmp_dir / "adv.json"
        adv_json.write_text(json.dumps(adv_payload), encoding="utf-8")
        res_adv_soft = subprocess.run(
            [sys.executable, str(LINTER_PY), "--mode", "explainer", str(adv_json)],
            capture_output=True,
            text=True,
        )
        assert res_adv_soft.returncode == 0
        for expected_tag in (
            "Formulaic opener",
            "Copulative avoidance",
            "Superficial trailing '-ing'",
            "Negative parallelism",
            "Rule of Three",
            "pivotal",
            "testament",
        ):
            assert expected_tag in res_adv_soft.stdout, f"Missing advisory '{expected_tag}' in:\n{res_adv_soft.stdout}"

        res_adv_strict = subprocess.run(
            [sys.executable, str(LINTER_PY), "--strict", "--mode", "explainer", str(adv_json)],
            capture_output=True,
            text=True,
        )
        assert res_adv_strict.returncode == 2


def test_s4_systematic_grapheme_parity_with_atproto_richtext() -> None:
    """Seeded systematic exploration: compare lint_thread.py batch_grapheme_counts and python_grapheme_count against @atproto/api RichText across 200 generated strings."""
    linter = load_module("linter", LINTER_PY)
    node_bin = linter.find_node_binary()
    assert node_bin, "Node binary required for @atproto/api RichText oracle"

    rng = random.Random(20261110)
    atoms = [
        "a", "Z", "9", " ", "\n", "\r\n",
        "é", "e\u0301", "n\u0303", "o\u0308\u0304",
        "🇺🇸", "🇯🇵", "🇺🇳",
        "👍", "👍🏽", "👩🏾‍🔬", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🧵",
        "日本語", "العربية", "§", "“quote”",
        "https://clerk.house.gov/Votes/2026317",
        "@mike10010100.com",
    ]

    cases: list[str] = []
    for i in range(200):
        # Mix short tricky clusters and ~295-305 boundary strings
        if i < 120:
            k = rng.randint(1, 35)
            s = "".join(rng.choice(atoms) for _ in range(k))
        else:
            base = "x" * rng.randint(285, 299)
            tail = "".join(rng.choice(atoms) for _ in range(rng.randint(1, 8)))
            s = base + tail
        cases.append(s)

    # Independent oracle: @atproto/api RichText.graphemeLength in bsky-mcp-server
    oracle_js = """
import { RichText } from '@atproto/api';
import fs from 'node:fs';
const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
const counts = inputs.map(text => new RichText({ text }).graphemeLength);
process.stdout.write(JSON.stringify(counts));
"""
    proc = subprocess.run(
        [node_bin, "--input-type=module", "-e", oracle_js],
        input=json.dumps(cases),
        text=True,
        capture_output=True,
        cwd=str(REPO_ROOT),
        check=True,
    )
    oracle_counts = json.loads(proc.stdout)
    batch_counts = linter.batch_grapheme_counts(cases)

    assert batch_counts == oracle_counts, "batch_grapheme_counts diverged from @atproto/api RichText!"

    # Also verify pure-Python fallback stays exact on standard prose, accents, flags, skin tones, and ZWJ emojis
    mismatches = 0
    for idx, (s, expected) in enumerate(zip(cases, oracle_counts)):
        py_c = linter.python_grapheme_count(s)
        if py_c != expected:
            mismatches += 1
    assert mismatches == 0, f"python_grapheme_count diverged on {mismatches}/200 generated Unicode cases"


def main() -> int:
    suites = [
        ("R1: WP:AISIGNS self-closing <ref/> & nested {{cot}} regression", test_r1_aisigns_self_closing_ref_and_nested_cot_regression),
        ("R2: Voice sampler excludes @bot-pings/URLs & reconstructs mode-stratified self-threads", test_r2_sampler_excludes_bot_ping_and_bare_urls_while_reconstructing_threads),
        ("S3: lint_thread.py hard gates, schema checks, image alts, and WP:AISIGNS advisories", test_s3_linter_cli_contracts),
        ("S4: Systematic grapheme exploration (seed=20261110, 200 Unicode/ZWJ/URL cases vs @atproto/api RichText)", test_s4_systematic_grapheme_parity_with_atproto_richtext),
    ]
    failed = 0
    for name, fn in suites:
        try:
            fn()
            print(f"ok - {name}")
        except Exception as exc:
            failed += 1
            print(f"FAIL - {name}: {exc}", file=sys.stderr)
            raise
    print(f"\n{len(suites)} / {len(suites)} threadcraft skill suite(s) passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
