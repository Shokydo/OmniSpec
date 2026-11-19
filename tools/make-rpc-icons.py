#!/usr/bin/env python3
"""Generate public Discord-RPC copies of OmniSpec's built-in instance icons.

Requirements: Pillow, ImageMagick (convert) and DejaVu Sans.  The paths are
copied from the launcher sprite; no user images are included or uploaded.
"""
from pathlib import Path
import re
import subprocess
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1]
html = (root / 'apps/omnispec-app/ui/index.html').read_text(encoding='utf-8')
out = root / 'apps/omnispec-app/ui/assets/rpc'
out.mkdir(parents=True, exist_ok=True)
icons = ('cube star heart flame bolt gem shield leaf crown house globe grid mod terminal folder download').split()
for icon in icons:
    match = re.search(r'<symbol id="i-' + re.escape(icon) + r'"[^>]*>(.*?)</symbol>', html)
    if not match:
        raise RuntimeError(f'icon {icon} not found')
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="256" height="256">'
           '<rect width="24" height="24" fill="#242428"/>'
           '<g fill="#f0f0f2" transform="translate(2.4 2.4) scale(.8)">'
           + match.group(1) + '</g></svg>')
    result = subprocess.run(['convert', 'svg:-', 'png:-'], input=svg.encode(), capture_output=True, check=True)
    Image.open(BytesIO(result.stdout)).convert('RGB').save(out / f'i-{icon}.png', optimize=True)

# Same fallback as the UI: the first uppercase character of the instance name.
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 135)
characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ?'
for char in characters:
    image = Image.new('RGB', (256, 256), '#242428')
    draw = ImageDraw.Draw(image)
    draw.text((128, 130), char, font=font, fill='#f0f0f2', anchor='mm')
    image.save(out / f'letter-{ord(char):04x}.png', optimize=True)
print(f'Generated {len(icons)} icons and {len(characters)} letters in {out}')
