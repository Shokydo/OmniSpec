#!/usr/bin/env python3
"""Version history uses immutable tag notes, safely falls back for old releases."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("omnispec_site", ROOT / "site/build.py")
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)


def git(root, *args):
    env = {**os.environ, "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
           "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
    return subprocess.run(["git", "-C", str(root), *args], check=True, env=env,
                          text=True, capture_output=True).stdout.strip()


with tempfile.TemporaryDirectory(prefix="omnispec-site-test-") as temp:
    root = Path(temp)
    git(root, "init", "-q")
    (root / "one.txt").write_text("old", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-qm", "Первый релиз; без заметок")
    git(root, "tag", "v0.1.0")
    notes = root / "release-notes"
    notes.mkdir()
    (notes / "v0.2.0.md").write_text("- Исторический `файл` <важно> & готово.\n  Продолжение.\n- Второй пункт.\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-qm", "Техническая тема коммита")
    git(root, "tag", "v0.2.0")
    # A later edit must not silently rewrite the published release's history.
    (notes / "v0.2.0.md").write_text("- Новая рабочая версия.\n", encoding="utf-8")
    (notes / "v0.3.0.md").write_text("- Новые фильтры.\n- Новые звуки.\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-qm", "Тестовый коммит")
    git(root, "tag", "-a", "v0.3.0", "-m", "Релиз")
    git(root, "tag", "v99.1.1-rc1")  # pre-releases are not simple version tags
    site.ROOT = str(root)
    releases = site.releases_from_git()
    assert [r["tag"] for r in releases] == ["v0.3.0", "v0.2.0", "v0.1.0"]
    assert releases[0]["bullets"] == ["Новые фильтры.", "Новые звуки."]
    assert releases[1]["bullets"] == ["Исторический файл <важно> & готово. Продолжение.", "Второй пункт."]
    assert releases[2]["bullets"] == ["Первый релиз", "Без заметок"]
    html = site.changelog_all(releases)
    assert "&lt;важно&gt; &amp; готово" in html and "Новая рабочая версия" not in html
    assert "Исторический файл <важно>" not in html
print("SITE_RELEASE_NOTES: immutable tagged notes, legacy fallback, sorting and HTML escaping — OK")
