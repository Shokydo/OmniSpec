#!/usr/bin/env python3
"""Offline checks for the release announcement and absence of public webhooks."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile
import textwrap
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
HEADER = "          python3 - <<'PYEOF'\n"
FOOTER = "          PYEOF"
assert WORKFLOW.count(HEADER) == 1
SCRIPT = textwrap.dedent(WORKFLOW.split(HEADER, 1)[1].split(FOOTER, 1)[0])
# This is an invented non-working URL; do not put real webhook URLs in tests.
FAKE_URL = "https://" + "discord.com/api/" + "webhooks/123456789012345678/fake_test_token_123"


class FakeResponse:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def __init__(self, failure=None):
        self.failure = failure
        self.request = None
        self.timeout = None

    def open(self, request, timeout=None):
        self.request = request
        self.timeout = timeout
        if self.failure:
            raise self.failure
        return FakeResponse()


def execute(secret, opener):
    output = io.StringIO()
    env = {"TAG": "v0.0.0-test"}
    if secret is not None:
        env["DISCORD_WEBHOOK"] = secret
    with patch.dict(os.environ, env, clear=True), \
         patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "## What's Changed\nТест")), \
         patch("urllib.request.build_opener", return_value=opener) as build_opener, \
         contextlib.redirect_stdout(output):
        exec(compile(SCRIPT, "release-announcement", "exec"), {})
        if build_opener.call_args:
            opener.redirect_handler = build_opener.call_args.args[0]
    return output.getvalue()


class DiscordReleaseTests(unittest.TestCase):
    def test_release_body_contains_only_notes_for_exact_tag(self):
        build = runpy.run_path(str(ROOT / "tools/release_body.py"))["build_release_body"]
        body = build("v0.49.1")
        self.assertIn("## What's Changed", body)
        self.assertIn("Fabric API", body)
        self.assertIn("OmniSpec-Setup.exe", body)
        self.assertNotIn("SHA-512", body)
        self.assertIn("SHA-512", build("v0.49.2"))
        previous = build("v0.49.3")
        self.assertIn("каталог больше не возвращается наверх", previous)
        self.assertIn("через 3 секунды", previous)
        latest = build("v0.49.4")
        self.assertIn("ярлыков Windows", latest)
        self.assertIn("Enter в пустой области", latest)
        self.assertNotIn("SHA-512", latest)
        catalog = build("v0.49.5")
        self.assertIn("вкладка «скачать моды»", catalog.lower())
        self.assertIn("CurseForge", catalog)
        self.assertIn("без обязательного Enter", catalog)
        self.assertNotIn("ярлыков Windows", catalog)
        preferences = build("v0.49.6")
        self.assertIn("начальную вкладку", preferences)
        self.assertIn("CurseForge", preferences)
        self.assertIn("физическую ОЗУ", preferences)
        self.assertIn("omnispec-setup.bin", preferences)
        self.assertNotIn("без обязательного Enter", preferences)
        with tempfile.TemporaryDirectory() as tmp:
            notes = Path(tmp) / "notes"
            notes.mkdir()
            (notes / "v1.2.3.md").write_text("notes for first version", encoding="utf-8")
            (notes / "v1.2.4.md").write_text("notes for next version", encoding="utf-8")
            self.assertIn("notes for first version", build("v1.2.3", notes))
            self.assertNotIn("notes for first version", build("v1.2.4", notes))
            self.assertNotIn("notes for next version", build("v1.2.5", notes))
            (Path(tmp) / "secret.md").write_text("must not be read", encoding="utf-8")
            self.assertNotIn("must not be read", build("../secret", notes))
            result = subprocess.run(
                ["python3", str(ROOT / "tools/release_body.py")], cwd=tmp,
                env={**os.environ, "RELEASE_TAG": "v0.49.1"}, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((Path(tmp) / "dist/release-notes.md").read_text(encoding="utf-8"), body)
        self.assertIn("body_path: dist/release-notes.md", WORKFLOW)

    def test_wallpaper_controls_notes_state_the_scene_audio_limit(self):
        build = runpy.run_path(str(ROOT / "tools/release_body.py"))["build_release_body"]
        body = build("v0.49.10")
        self.assertIn("Wallpaper Engine", body)
        self.assertIn("звук видео Workshop", body)
        self.assertIn("звук сцен", body.lower())
        self.assertIn("пока не регулируется", body)
        self.assertIn("рабочего стола", body)
        self.assertNotIn("пока не регулируется", build("v0.49.9"))

    def test_icon_patch_notes_match_exact_release(self):
        build = runpy.run_path(str(ROOT / "tools/release_body.py"))["build_release_body"]
        body = build("v0.49.11")
        self.assertIn("выровнены по центру", body)
        self.assertIn("Буквенные заглушки", body)
        self.assertIn("Все сборки", body)
        self.assertIn("150%", body)
        self.assertIn("звук обоев рабочего стола не меняется", body)
        self.assertNotIn("выровнены по центру", build("v0.49.10"))

    def test_release_assets_are_safe_for_legacy_linux_updaters(self):
        # Versions through v0.49.5 considered every omnispec* name without a dot
        # to be a launcher. The installer must not match, regardless of order.
        files = re.findall(r"^\s+dist/([^/\s]+)\s*$", WORKFLOW, re.MULTILINE)
        self.assertIn("omnispec-setup.bin", files)
        self.assertIn("omnispec-setup.bin.sha256", files)
        legacy_candidates = [name for name in files
                             if not name.endswith((".sha256", ".sig"))
                             and (name.lower() == "omnispec"
                                  or (name.lower().startswith("omnispec") and "." not in name))]
        self.assertEqual(legacy_candidates, ["OmniSpec"])

    def test_success_posts_blue_embed_without_mentions_or_redirects(self):
        opener = FakeOpener()
        output = execute(FAKE_URL, opener)
        self.assertIn("Discord анонс отправлен: 204", output)
        self.assertNotIn(FAKE_URL, output)
        self.assertEqual(opener.request.full_url, FAKE_URL)
        self.assertEqual(opener.request.get_method(), "POST")
        self.assertEqual(opener.timeout, 20)
        self.assertTrue(issubclass(opener.redirect_handler, urllib.request.HTTPRedirectHandler))
        self.assertIsNone(opener.redirect_handler().redirect_request(None, None, 302, "redirect", {}, "https://other.example"))
        payload = json.loads(opener.request.data)
        self.assertEqual(payload["embeds"][0]["color"], 0x5865F2)
        self.assertEqual(payload["embeds"][0]["title"], "🚀 OmniSpec v0.0.0-test")
        self.assertEqual(payload["allowed_mentions"], {"parse": []})
        self.assertIn("Тест", payload["embeds"][0]["description"])

    def test_missing_and_invalid_secrets_are_rejected(self):
        for secret in (None, "", "https://evil.example/api/webhooks/123456789012345678/fake_test_token_123", FAKE_URL + "#fragment", FAKE_URL.replace("https:", "http:")):
            opener = FakeOpener()
            with self.subTest(secret_type=type(secret).__name__), self.assertRaises(SystemExit):
                execute(secret, opener)
            self.assertIsNone(opener.request)

    def test_network_errors_do_not_disclose_secret_or_response(self):
        errors = [
            urllib.error.HTTPError(FAKE_URL, 403, "private upstream response", {}, None),
            urllib.error.URLError("private connection details " + FAKE_URL),
        ]
        for error in errors:
            with self.subTest(kind=type(error).__name__), self.assertRaises(SystemExit) as caught:
                execute(FAKE_URL, FakeOpener(error))
            self.assertNotIn(FAKE_URL, str(caught.exception))
            self.assertNotIn("private", str(caught.exception))

    def test_no_direct_webhook_url_in_tracked_worktree(self):
        pattern = r"https://(discord(app)?\.com|canary\.discord\.com|ptb\.discord\.com)/api/webhooks/[0-9]+"
        result = subprocess.run(["git", "grep", "-I", "-l", "-E", pattern], cwd=ROOT, capture_output=True, text=True)
        self.assertIn(result.returncode, (0, 1))
        self.assertEqual(result.stdout.strip(), "", "Remove webhook URLs from these tracked files:\n" + result.stdout)
        self.assertIn("${{ secrets.DISCORD_WEBHOOK }}", WORKFLOW)

    def test_feedback_ui_and_command_are_removed(self):
        for filename, needles in {
            "site/src/index.tpl.html": ("fb-open", "fb-overlay"),
            "site/dist/index.html": ("fb-open", "fb-overlay"),
            "site/dist/changelog.html": ("fb-overlay",),
            "apps/omnispec-app/ui/index.html": ("btn-feedback", "modal-feedback"),
            "apps/omnispec-app/ui/app.js": ("sendFeedback",),
            "apps/omnispec-app/src/main.rs": ("send_feedback",),
        }.items():
            text = (ROOT / filename).read_text(encoding="utf-8")
            for needle in needles:
                with self.subTest(filename=filename, needle=needle):
                    self.assertNotIn(needle, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
