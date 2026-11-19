#!/usr/bin/env python3
"""Offline checks for the release announcement and absence of public webhooks."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
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
