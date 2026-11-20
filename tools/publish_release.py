#!/usr/bin/env python3
"""Публиковать черновик только после проверки файлов обеих платформ.

Вызывается workflow Release с RELEASE_ID, RELEASE_TAG и GITHUB_TOKEN.
Неполная или повреждённая загрузка остаётся черновиком и не попадает в latest.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

BINARIES = ("OmniSpec.exe", "OmniSpec-Setup.exe", "OmniSpec", "omnispec-setup.bin")
EXPECTED = frozenset(BINARIES + tuple(name + ".sha256" for name in BINARIES))


class ReleaseError(Exception):
    pass


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def local_manifest(directory):
    directory = Path(directory)
    manifest = {}
    for name in sorted(EXPECTED):
        path = directory / name
        if not path.is_file() or path.stat().st_size <= 0:
            raise ReleaseError(f"Нет непустого файла: {name}")
        manifest[name] = {"size": path.stat().st_size, "sha256": file_digest(path)}
    for name in BINARIES:
        text = (directory / (name + ".sha256")).read_text(encoding="ascii").strip()
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?([^\r\n]+)", text)
        if not match or match[1].lower() != manifest[name]["sha256"] or match[2] != name:
            raise ReleaseError(f"Неверная контрольная сумма или имя: {name}")
    return manifest


def validate_draft(release, tag, release_id, manifest):
    if (release.get("id") != release_id or release.get("tag_name") != tag
            or release.get("draft") is not True or release.get("prerelease") is not False):
        raise ReleaseError("Получен не тот черновик релиза")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ReleaseError("У черновика отсутствует список файлов")
    by_name = {}
    for asset in assets:
        name = asset.get("name")
        if name in by_name:
            raise ReleaseError(f"Повторный файл в черновике: {name}")
        by_name[name] = asset
    missing = EXPECTED - by_name.keys()
    if missing:
        raise ReleaseError("В черновике отсутствуют файлы: " + ", ".join(sorted(missing)))
    for name in sorted(EXPECTED):
        asset, local = by_name[name], manifest[name]
        if asset.get("state") != "uploaded" or asset.get("size") != local["size"]:
            raise ReleaseError(f"Файл не загружен целиком: {name}")
        # GitHub предоставляет digest не для всех старых серверов; если он есть,
        # дополнительно сверяем его с локальной контрольной суммой.
        remote_digest = asset.get("digest")
        if remote_digest is not None and remote_digest != "sha256:" + local["sha256"]:
            raise ReleaseError(f"GitHub digest не совпадает: {name}")


def github_request(repo, release_id, token, method, data=None):
    url = f"https://api.github.com/repos/{repo}/releases/{release_id}"
    headers = {"Accept": "application/vnd.github+json", "Authorization": "Bearer " + token,
               "User-Agent": "OmniSpec-release-publisher", "X-GitHub-Api-Version": "2022-11-28"}
    payload = None if data is None else json.dumps(data).encode("utf-8")
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def publish(repo, release_id, tag, token, directory="dist", request=github_request):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ReleaseError("Некорректный репозиторий")
    if not isinstance(release_id, int) or release_id < 1:
        raise ReleaseError("Некорректный ID черновика")
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", tag):
        raise ReleaseError("Некорректный тег релиза")
    if not token:
        raise ReleaseError("Нет токена GitHub Actions")
    manifest = local_manifest(directory)
    draft = request(repo, release_id, token, "GET")
    validate_draft(draft, tag, release_id, manifest)
    print(f"RELEASE_DRAFT_VERIFIED {tag}: восемь файлов, размеры и SHA-256", flush=True)
    published = request(repo, release_id, token, "PATCH", {"draft": False, "make_latest": "true"})
    if (published.get("id") != release_id or published.get("tag_name") != tag
            or published.get("draft") is not False or published.get("prerelease") is not False):
        raise ReleaseError("GitHub не подтвердил публикацию ожидаемого релиза")
    print("RELEASE_PUBLISHED", published.get("html_url", ""), flush=True)


def main():
    try:
        raw_id = os.environ.get("RELEASE_ID", "")
        if not raw_id.isdecimal():
            raise ReleaseError("Некорректный ID черновика")
        publish(os.environ.get("GITHUB_REPOSITORY", ""), int(raw_id),
                os.environ.get("RELEASE_TAG", ""), os.environ.get("GITHUB_TOKEN", "").strip())
    except urllib.error.HTTPError as error:
        print(f"Публикация отклонена GitHub: HTTP {error.code}", file=sys.stderr)
        return 1
    except (ReleaseError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Релиз не опубликован: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
