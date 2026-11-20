#!/usr/bin/env python3
"""Офлайн-проверка атомарной публикации и отказа при неполных артефактах."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("publish_release", ROOT / "tools/publish_release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        for name in release.BINARIES:
            payload = ("example bytes: " + name).encode()
            (self.directory / name).write_bytes(payload)
            digest = hashlib.sha256(payload).hexdigest()
            (self.directory / (name + ".sha256")).write_text(digest + "  " + name + "\r\n", encoding="ascii")
        self.manifest = release.local_manifest(self.directory)
        self.draft = {"id": 123, "tag_name": "v0.49.11", "draft": True, "prerelease": False,
                      "assets": [{"name": name, "state": "uploaded", "size": data["size"],
                                  "digest": "sha256:" + data["sha256"]}
                                 for name, data in self.manifest.items()]}
        self.calls = []

    def request(self, repo, release_id, token, method, data=None):
        self.calls.append((method, data))
        if method == "GET":
            return copy.deepcopy(self.draft)
        self.assertEqual(method, "PATCH")
        return {**self.draft, "draft": False, "html_url": "https://github.com/example/release"}

    def publish(self):
        release.publish("owner/project", 123, "v0.49.11", "fake-token", self.directory, request=self.request)

    def test_publishes_only_after_comparing_all_eight_files(self):
        self.publish()
        self.assertEqual(self.calls, [("GET", None), ("PATCH", {"draft": False, "make_latest": "true"})])

    def test_missing_remote_platform_file_never_publishes(self):
        self.draft["assets"] = [a for a in self.draft["assets"] if a["name"] != "OmniSpec.exe"]
        with self.assertRaisesRegex(release.ReleaseError, "отсутствуют"):
            self.publish()
        self.assertEqual(self.calls, [("GET", None)])

    def test_wrong_remote_size_digest_or_duplicate_never_publishes(self):
        for defect in ("size", "digest", "duplicate", "uploading"):
            with self.subTest(defect=defect):
                good = copy.deepcopy(self.draft)
                if defect == "size": self.draft["assets"][0]["size"] += 1
                if defect == "digest": self.draft["assets"][0]["digest"] = "sha256:" + "0" * 64
                if defect == "duplicate": self.draft["assets"].append(copy.deepcopy(self.draft["assets"][0]))
                if defect == "uploading": self.draft["assets"][0]["state"] = "new"
                with self.assertRaises(release.ReleaseError): self.publish()
                self.assertEqual(self.calls, [("GET", None)])
                self.draft, self.calls = good, []

    def test_wrong_tag_or_already_public_never_publishes(self):
        for key, value in (("tag_name", "v0.49.10"), ("draft", False), ("prerelease", True), ("id", 456)):
            with self.subTest(key=key):
                good = copy.deepcopy(self.draft)
                self.draft[key] = value
                with self.assertRaisesRegex(release.ReleaseError, "не тот черновик"):
                    self.publish()
                self.assertEqual(self.calls, [("GET", None)])
                self.draft, self.calls = good, []

    def test_bad_local_checksum_or_missing_file_fails_before_network(self):
        (self.directory / "OmniSpec.exe.sha256").write_text("0" * 64 + "  OmniSpec.exe\n", encoding="ascii")
        with self.assertRaisesRegex(release.ReleaseError, "контрольная сумма"):
            self.publish()
        self.assertEqual(self.calls, [])
        (self.directory / "OmniSpec.exe").unlink()
        with self.assertRaisesRegex(release.ReleaseError, "Нет непустого файла"):
            self.publish()
        self.assertEqual(self.calls, [])

    def test_optional_remote_digest_and_windows_line_endings(self):
        for asset in self.draft["assets"]:
            asset["digest"] = None
        self.publish()
        self.assertEqual([method for method, _ in self.calls], ["GET", "PATCH"])

    def test_workflow_waits_for_both_builds_and_validates_draft(self):
        text = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        block = text.split("  publish:\n", 1)[1].split("  announce:\n", 1)[0]
        self.assertIn("needs: [windows, linux]", block)
        self.assertIn("name: release-windows", block)
        self.assertIn("name: release-linux", block)
        self.assertIn("draft: true", block)
        self.assertIn("fail_on_unmatched_files: true", block)
        self.assertIn("steps.release_draft.outputs.id", block)
        self.assertIn("python3 tools/publish_release.py", block)
        for name in release.EXPECTED:
            self.assertIn("dist/" + name + "\n", block)
        self.assertIn("needs: [publish]", text.split("  announce:\n", 1)[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
