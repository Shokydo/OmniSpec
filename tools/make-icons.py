#!/usr/bin/env python3
"""Собирает все иконки OmniSpec из одного исходника.

    python3 tools/make-icons.py

Исходник — apps/omnispec-app/icon-source.jpg (295×295, ч/б картинка).
Скрипт делает:
  * мастер 1024×1024 (апскейл + лёгкий шарп), чтобы линии остались линиями;
  * PNG 32/64/128/256/512 для Tauri и ярлыков;
  * многоразмерный .ico для exe и панели задач Windows;
  * логотип в интерфейсе (ui/assets/logo.png) и favicon.

Раньше мелкие размеры кропились (лицо «в упор») — на панели задач это
выглядело как зум. Теперь наоборот: картинка вписывается с полями, чтобы
иконка дышала и не липла к краям.
"""

from pathlib import Path

from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "apps" / "omnispec-app"
SOURCE = APP / "icon-source.jpg"
# сколько места занимает картинка внутри квадрата иконки
SCALE_TINY = 0.74          # 16–32 px: сильнее поля, иначе лицо «в упор»
SCALE_SMALL = 0.80         # 33–64 px
SCALE_LARGE = 0.88         # всё, что крупнее


def scale_for(size: int) -> float:
    if size <= 32:
        return SCALE_TINY
    if size <= 64:
        return SCALE_SMALL
    return SCALE_LARGE


def build_master() -> Image.Image:
    source = Image.open(SOURCE)
    master = source.convert("L").resize((1024, 1024), Image.LANCZOS)
    master = master.filter(ImageFilter.UnsharpMask(radius=1.6, percent=55, threshold=2))
    master = ImageOps.autocontrast(master, cutoff=0)
    # Tauri требует RGBA: PNG в режиме «L»/«RGB» он отвергает
    return master.convert("RGBA")


def render(master: Image.Image, size: int) -> Image.Image:
    """Картинка по центру прозрачного квадрата, с полями — без зума в упор."""
    inner = max(8, int(round(size * scale_for(size))))
    image = master.resize((inner, inner), Image.LANCZOS)
    if size <= 64:
        # иначе на мелких размерах линии превращаются в серую кашу
        image = image.filter(ImageFilter.UnsharpMask(radius=0.7, percent=100, threshold=1))
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    offset = (size - inner) // 2
    canvas.paste(image.convert("RGBA"), (offset, offset))
    return canvas


def main() -> None:
    master = build_master()
    icons = APP / "icons"
    icons.mkdir(exist_ok=True)

    for size, name in [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon.png"),
        (512, "icon-512.png"),
    ]:
        render(master, size).save(icons / name, format="PNG", optimize=True)
        print(f"  icons/{name} — {size}×{size}")

    ico_sizes = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48),
                 (64, 64), (128, 128), (256, 256)]
    # .ico собираем из уже отрисованных размеров, чтобы поля применились
    frames = [render(master, size[0]) for size in ico_sizes]
    frames[-1].save(icons / "icon.ico", format="ICO",
                   sizes=ico_sizes, append_images=frames[:-1])
    print(f"  icons/icon.ico — {[s[0] for s in ico_sizes]}")

    render(master, 192).save(APP / "ui" / "assets" / "logo.png")
    render(master, 64).save(APP / "ui" / "favicon.png")
    print("  ui/assets/logo.png — 192×192, ui/favicon.png — 64×64")


if __name__ == "__main__":
    main()
