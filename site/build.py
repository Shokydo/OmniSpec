#!/usr/bin/env python3
"""Собирает статический сайт OmniSpec в site/dist.

    python3 site/build.py [--offline]

Что делает:
  · берёт список релизов из git-тегов и описание из release-notes в каждом теге
    (или из site/src/releases.json, если тегов нет);
  · уточняет последнюю версию и размеры файлов через GitHub API (--offline — не ходить в сеть);
  · вклáдывает CSS, JS и картинки внутрь HTML, чтобы страницы были самодостаточными;
  · пишет site/dist/index.html, site/dist/changelog.html, og.png, favicon.png.

Никаких зависимостей, кроме стандартной библиотеки Python 3.
"""

import base64
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # …/OmniSpec
SRC = os.path.join(ROOT, "site", "src")
DIST = os.path.join(ROOT, "site", "dist")
REPO = "Shokydo/OmniSpec"
SITE = "https://shokydo.github.io/OmniSpec/"
RAW = "https://raw.githubusercontent.com/Shokydo/OmniSpec/main/site/src/assets/"

MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня",
          "июля", "августа", "сентября", "октября", "ноября", "декабря"]

DEFAULT_LATEST = {
    "version": "0.31.0",
    "published_at": "2026-11-16",
    "downloads": 0,
    "setup": {"name": "OmniSpec-Setup.exe", "size": 11931136},
    "portable": {"name": "OmniSpec.exe", "size": 8188928},
    "linux": {"name": "OmniSpec", "size": 10088008},
}


def downloads_text(count):
    """«скачано 1 234 раза» — пусто, если скачиваний ещё не было."""
    if not count:
        return ""
    n = int(count)
    if n % 10 == 1 and n % 100 != 11:
        word = "раз"
    elif n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        word = "раза"
    else:
        word = "раз"
    num = f"{n:,}".replace(",", "\u00a0")
    return f"<span>·</span><span>скачано {num} {word}</span>"


def human_date(iso):
    """ISO date or timestamp → a readable Russian date."""
    try:
        value = iso.replace("Z", "+00:00")
        if "T" in value:
            value = value.split("T", 1)[0]
        y, m, d = (int(x) for x in value.split("-")[:3])
        return f"{d} {MONTHS[m - 1]} {y}"
    except Exception:
        return iso


def mb(size):
    return f"{size / (1024 * 1024):.1f} МБ".replace(".", ",")


# ── релизы ──────────────────────────────────────────────────────

def clean_subject(subject):
    """Убираем «этап 31:» и хвост «; 0.31.0», оставляем суть."""
    text = subject.strip()
    text = re.sub(r"[;,]?\s*(версия\s+)?v?\d+\.\d+\.\d+\s*$", "", text, flags=re.I)
    text = re.sub(r"^\s*этап\s*\d+\s*[:.]\s*", "", text, flags=re.I)
    text = text.strip(" ;,")
    return text


def split_top(text, sep):
    """Делит строку по sep только вне скобок: запятые внутри «(...)» не считаются."""
    parts, buf, depth = [], "", 0
    i = 0
    while i < len(text):
        ch = text[i]
        if ch in "([«":
            depth += 1
        elif ch in ")]»" and depth:
            depth -= 1
        if depth == 0 and text.startswith(sep, i):
            parts.append(buf)
            buf = ""
            i += len(sep)
            continue
        buf += ch
        i += 1
    parts.append(buf)
    return [p.strip(" .") for p in parts if p.strip(" .")]


def split_bullets(text):
    """«а; б, в» → пункты. Запятые режут только длинные перечисления."""
    out = []
    for clause in split_top(text, ";"):
        pieces = split_top(clause, ", ")
        if len(pieces) > 1 and len(clause) > 70:
            merged = []
            for piece in pieces:
                prev = merged[-1] if merged else ""
                # короткий хвост и текст после «—» — это продолжение прошлого пункта
                if merged and (len(piece) < 26 or "—" in prev):
                    merged[-1] = prev + ", " + piece
                else:
                    merged.append(piece)
            out.extend(merged)
        else:
            out.append(clause)
    out = [part[0].upper() + part[1:] if part else part for part in out]
    return out or [text]


def release_notes_from_git(tag):
    """Пункты описания именно на момент тега, не текущий рабочий файл.

    Старые релизы без отдельного описания по-прежнему используют тему коммита.
    На сайте показываем обычный текст, поэтому убираем обратные кавычки Markdown;
    HTML экранируется позже при формировании разметки.
    """
    try:
        result = subprocess.run(
            ["git", "-C", ROOT, "show", f"{tag}:release-notes/{tag}.md"],
            capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    bullets = []
    for line in result.stdout.splitlines():
        match = re.match(r"^[-*]\s+(.+?)\s*$", line)
        if match:
            bullets.append(match.group(1).replace("`", ""))
        elif bullets and line[:1].isspace() and line.strip():
            bullets[-1] += " " + line.strip().replace("`", "")
    return bullets or None


def releases_from_git():
    try:
        tags = subprocess.run(
            ["git", "-C", ROOT, "tag", "--sort=-v:refname"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
    except Exception:
        return None
    if not tags:
        return None
    items = []
    for tag in tags:
        # Только простые версии используются в именах файлов и ссылках сайта.
        if not re.fullmatch(r"v?\d+\.\d+\.\d+", tag):
            continue
        try:
            meta = subprocess.run(
                ["git", "-C", ROOT, "log", "-1", "--format=%ad%x00%s", "--date=short", f"{tag}^{{commit}}"],
                capture_output=True, text=True, check=True,
            ).stdout.strip()
        except Exception:
            continue
        date, _, subject = meta.partition("\x00")
        version = tag.lstrip("v")
        items.append({
            "version": version,
            "tag": tag,
            "date": date,
            "bullets": release_notes_from_git(tag) or split_bullets(clean_subject(subject)),
        })
    items.sort(key=lambda x: version_key(x["version"]), reverse=True)
    return items or None


def version_key(v):
    return [int(x) for x in v.split(".")]


def releases_from_file():
    path = os.path.join(SRC, "releases.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _release_downloads(release):
    return sum(
        a.get("download_count", 0)
        for a in release.get("assets", [])
        if not a["name"].endswith(".sha256")
    )


def total_downloads_from_api(headers):
    """Накопленное число скачиваний по ВСЕМ релизам — счётчик не обнуляется
    при выходе нового релиза (у свежего релиза скачиваний ещё нет)."""
    total = 0
    page = 1
    while True:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            batch = json.load(resp)
        if not batch:
            break
        for release in batch:
            total += _release_downloads(release)
        if len(batch) < 100:
            break
        page += 1
    return total


def latest_from_api():
    headers = {"User-Agent": "OmniSpec-site-builder", "Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases/latest",
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    by_name = {a["name"]: a["size"] for a in data.get("assets", [])}
    pick = lambda name: {"name": name, "size": by_name.get(name, 0)}
    try:
        downloads = total_downloads_from_api(headers)
    except Exception:
        downloads = _release_downloads(data)
    return {
        "version": data["tag_name"].lstrip("v"),
        "published_at": (data.get("published_at") or "")[:10],
        "downloads": downloads,
        "setup": pick("OmniSpec-Setup.exe"),
        "portable": pick("OmniSpec.exe"),
        "linux": pick("OmniSpec"),
    }


# ── разметка ────────────────────────────────────────────────────

def release_block(rel, prev, with_day=False):
    v = rel["version"]
    cmp_url = f"https://github.com/{REPO}/compare/v{prev}...v{v}" if prev else \
              f"https://github.com/{REPO}/releases/tag/v{v}"
    cmp_text = "что изменилось" if prev else "первый релиз"
    bullets = "".join(f"<li>{escape(b)}</li>" for b in rel["bullets"])
    html = [
        f'<article class="rel" data-rel id="v{escape(v)}">',
        f'  <div class="ver">v{escape(v)}<span>{human_date(rel["date"])}</span></div>',
        f'  <div class="body"><ul>{bullets}</ul>'
        f'<div class="links"><a href="https://github.com/{REPO}/releases/tag/v{escape(v)}">релиз на GitHub</a>'
        f'<a href="{cmp_url}">{cmp_text}</a></div></div>',
        "</article>",
    ]
    return "\n".join(html)


def escape(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def changelog_all(releases):
    out, day = [], None
    for i, rel in enumerate(releases):
        if rel["date"] != day:
            day = rel["date"]
            out.append(f'<h3 class="day" data-day>{human_date(day)}</h3>')
        prev = releases[i + 1]["version"] if i + 1 < len(releases) else None
        out.append(release_block(rel, prev))
    return "\n".join(out)


def changelog_teaser(releases, count=4):
    out = []
    for i, rel in enumerate(releases[:count]):
        prev = releases[i + 1]["version"] if i + 1 < len(releases) else None
        out.append(release_block(rel, prev))
    return "\n".join(out)


# ── ассеты ──────────────────────────────────────────────────────

def asset_uri(name):
    if name in ("icon", "favicon"):
        name = "icon-256" if name == "favicon" else name
    path = os.path.join(SRC, "assets", name + ".webp")
    if not os.path.exists(path):
        path = os.path.join(SRC, "assets", name + ".png")
    if not os.path.exists(path):
        raise SystemExit(f"нет файла ассета: {name}")
    mime = "image/webp" if path.endswith(".webp") else "image/png"
    with open(path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode()
    return f"data:{mime};base64,{data}"


def inline_assets(html):
    return re.sub(r"\{\{A:([a-z0-9\-]+)\}\}", lambda m: asset_uri(m.group(1)), html)


def read(path):
    with open(os.path.join(SRC, path), encoding="utf-8") as fh:
        return fh.read()


def fetch_latest(offline):
    """Последняя версия: сначала GitHub API, потом локальный снимок."""
    data = dict(DEFAULT_LATEST)
    snapshot = os.path.join(SRC, "latest.json")
    if os.path.exists(snapshot):
        with open(snapshot, encoding="utf-8") as fh:
            data.update(json.load(fh))
    if offline:
        return data
    try:
        api = latest_from_api()
    except Exception as exc:                      # сеть отвалилась — не беда
        print(f"! GitHub API недоступен ({exc}), беру site/src/latest.json")
        return data
    for key in ("version", "published_at"):
        if api.get(key):
            data[key] = api[key]
    if "downloads" in api:
        data["downloads"] = api["downloads"]
    for key in ("setup", "portable", "linux"):
        if api.get(key, {}).get("size"):
            data[key] = api[key]
    try:
        with open(snapshot, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
    except OSError:
        pass
    return data


def main():
    offline = "--offline" in sys.argv
    releases = releases_from_git() or releases_from_file()
    latest = fetch_latest(offline)

    tokens = {
        "{{CSS}}": read("style.css"),
        "{{JS}}": read("site.js"),
        "{{VERSION}}": latest["version"],
        "{{DATE}}": human_date(latest["published_at"]),
        "{{SIZE_SETUP}}": mb(latest["setup"]["size"]),
        "{{SIZE_PORTABLE}}": mb(latest["portable"]["size"]),
        "{{URL_SITE}}": SITE,
        "{{URL_REPO}}": f"https://github.com/{REPO}",
        "{{URL_RELEASES}}": f"https://github.com/{REPO}/releases",
        "{{URL_ISSUES}}": f"https://github.com/{REPO}/issues",
        "{{DOWNLOADS}}": downloads_text(latest.get("downloads", 0)),
        "{{URL_SETUP}}": f"https://github.com/{REPO}/releases/latest/download/OmniSpec-Setup.exe",
        "{{URL_PORTABLE}}": f"https://github.com/{REPO}/releases/latest/download/OmniSpec.exe",
        "{{URL_LINUX}}": f"https://github.com/{REPO}/releases/latest/download/OmniSpec",
        "{{CHANGELOG_ALL}}": changelog_all(releases),
        "{{CHANGELOG_TEASER}}": changelog_teaser(releases),
        "{{RELEASES_COUNT}}": str(len(releases)),
    }

    os.makedirs(DIST, exist_ok=True)
    for tpl, out in (("index.tpl.html", "index.html"), ("changelog.tpl.html", "changelog.html")):
        html = read(tpl)
        for key, value in tokens.items():
            html = html.replace(key, value)
        html = inline_assets(html)
        left = re.findall(r"\{\{[A-Z_:a-z0-9]+\}\}", html)
        if left:
            print(f"! не подставлены токены в {out}: {sorted(set(left))}")
        with open(os.path.join(DIST, out), "w", encoding="utf-8") as fh:
            fh.write(html)
        print(f"{out}: {len(html.encode('utf-8')) // 1024} КБ")

    for name, out in (("og.png", "og.png"), ("icon-256.png", "favicon.png")):
        src = os.path.join(SRC, "assets", name)
        with open(src, "rb") as a, open(os.path.join(DIST, out), "wb") as b:
            b.write(a.read())
    # .nojekyll — чтобы GitHub Pages не трогал файлы
    open(os.path.join(DIST, ".nojekyll"), "w").close()
    print("готово:", DIST)


if __name__ == "__main__":
    main()
