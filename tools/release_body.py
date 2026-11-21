#!/usr/bin/env python3
"""Build the release description, including optional notes for this exact tag."""
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def build_release_body(tag: str, notes_dir: Path = ROOT / "release-notes") -> str:
    tag = str(tag).strip()
    if not tag or "\n" in tag or "\r" in tag:
        raise ValueError("A valid release ref is required")
    body = f"""## OmniSpec {tag}

**Как установить:** два способа на выбор:
* `OmniSpec-Setup.exe` — установщик с кнопками: покажет, что и куда
  поставит, даст поменять папку установки, сделает ярлыки на рабочем
  столе и в «Пуск» и запустит лаунчер;
* `OmniSpec.exe` — портативная версия Windows: скачал и запустил, ничего не ставится;
* `OmniSpec` — портативная версия Linux, `omnispec-setup.bin` — установщик Linux.
  После скачивания выдай файлу право запуска: `chmod +x OmniSpec` или `chmod +x omnispec-setup.bin`.

Java и файлы Minecraft лаунчер скачает сам при первом запуске.

**Обновления:** лаунчер сам проверяет этот репозиторий и предлагает обновиться.

Требования: Windows 10/11 (на «десятке» нужен WebView2 — обычно уже установлен);
Linux x86-64 с GTK 3 и WebKitGTK 4.1, glibc не старше Ubuntu 22.04 (2.35).
"""
    # Only simple version tags may name a notes file; branch/manual runs still
    # get the original generic body and cannot select paths outside this folder.
    safe_tag = re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?", tag)
    notes_path = notes_dir / f"{tag}.md" if safe_tag else None
    if notes_path and notes_path.is_file():
        notes = notes_path.read_text(encoding="utf-8").strip()
        if notes:
            # This heading is also consumed by the Discord announcement job.
            body += f"\n## What's Changed\n\n{notes}\n"
    return body


def main() -> None:
    body = build_release_body(os.environ.get("RELEASE_TAG", ""))
    output = Path("dist/release-notes.md")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(body, encoding="utf-8")
    print("Release description prepared")


if __name__ == "__main__":
    main()
