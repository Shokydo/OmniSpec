#!/usr/bin/env python3
"""Real Linux Tauri/WebKitGTK avatar layout and nested scrolling.

Run with: dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' \
    /usr/bin/python3 tools/tests/avatar-linux-native.py
All accounts, settings, skins and user directories are temporary; no Minecraft
login or official-cape network operation is performed.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

sys.path.append('/usr/lib/python3/dist-packages')
import pyatspi

repo = pathlib.Path(__file__).resolve().parents[2]
binary = pathlib.Path(os.environ.get('AVATAR_BINARY', repo / 'target/debug/omnispec-app')).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='omnispec-avatar-native-'))
data, home, runtime = (root / name for name in ('data', 'home', 'runtime'))
for directory in (data, home, runtime):
    directory.mkdir()
runtime.chmod(0o700)
skin = data / 'skin.png'
shutil.copy2(repo / 'tools/tests/fixtures/profile/one.png', skin)
settings = {
    'onboarded': True, 'update_enabled': False, 'discord_rpc': False,
    'click_fx': 'off', 'ambient': 'off', 'trail': False, 'sound_fx': False,
    'ui_scale': 100, 'username': 'NativeFixture',
    'skin_presets': [
        {'id': f'skin-{i}', 'name': f'Skin {i:02d}', 'path': str(skin), 'variant': 'classic', 'angle': 0}
        for i in range(24)
    ],
    'skin_favorites': [{'id': 'legacy-fav', 'name': 'Native favorite', 'skinPath': str(skin),
                        'skinDataUrl': '', 'variant': 'classic', 'capeId': '', 'futureField': 'preserved'}],
}
(data / 'settings.json').write_text(json.dumps(settings, ensure_ascii=False), encoding='utf-8')
uuid = '00000000-0000-3000-8000-000000000001'
(data / 'accounts.json').write_text(json.dumps({'active': uuid, 'accounts': [
    {'username': 'NativeFixture', 'uuid': uuid, 'kind': 'offline', 'access_token': '', 'refresh_token': '', 'expires_at': 0}
]}), encoding='utf-8')
env = {**os.environ, 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'),
       'XDG_CACHE_HOME': str(home / '.cache'), 'XDG_DATA_HOME': str(home / '.local/share'),
       'XDG_RUNTIME_DIR': str(runtime), 'OMNISPEC_HOME': str(data),
       'WEBKIT_DISABLE_COMPOSITING_MODE': '1', 'WEBKIT_DISABLE_DMABUF_RENDERER': '1'}
log = (root / 'launcher.log').open('w')
proc = None


def walk(node):
    yield node
    try:
        for child in node:
            yield from walk(child)
    except Exception:
        pass


def find(name, partial=False):
    for node in walk(pyatspi.Registry.getDesktop(0)):
        try:
            label = node.name or ''
            if (name in label if partial else label == name) and node.getState().contains(pyatspi.STATE_SHOWING):
                return node
        except Exception:
            pass
    return None


def wait(name, timeout=45, partial=False):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        node = find(name, partial)
        if node:
            return node
        if proc and proc.poll() is not None:
            raise RuntimeError(f'Launcher exited: {proc.returncode}')
        time.sleep(.15)
    raise AssertionError(f'Accessible element not found: {name!r}')


def click(name):
    node = wait(name)
    action = node.queryAction()
    if not action.nActions or not action.doAction(0):
        raise RuntimeError(f'Cannot invoke {name!r}')


def bounds(node):
    rect = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    return (rect.x, rect.y, rect.width, rect.height)


try:
    proc = subprocess.Popen([str(binary)], stdout=log, stderr=log, env=env)
    wait('Настройки', 90)
    ids = subprocess.check_output(['xdotool', 'search', '--name', '^OmniSpec$'], text=True).strip().splitlines()
    if len(ids) != 1:
        raise AssertionError(f'Expected one isolated OmniSpec window, got {ids}')
    subprocess.run(['xdotool', 'windowmove', ids[0], '0', '0'], check=True)
    subprocess.run(['xdotool', 'windowsize', ids[0], '1080', '640'], check=True)
    click('Настройки')
    click('Аватар')
    library = wait('Библиотека скинов')
    capes = wait('Гардероб плащей')
    apply = wait('Применить к аккаунту')
    wait('Native favorite', partial=True)
    if apply.getState().contains(pyatspi.STATE_ENABLED):
        raise AssertionError('Offline account can change the official skin')
    lx, ly, lw, lh = bounds(library)
    cx, cy, cw, ch = bounds(capes)
    mx, my, mw, mh = bounds(apply)
    assert lw > 100 and lh > 50 and cw > 100 and ch > 40
    assert lx >= mx + mw and cy >= max(ly + lh, my + mh), (bounds(library), bounds(capes), bounds(apply))
    assert cx >= 0 and cy + ch <= 640 and cx + cw <= 1080, bounds(capes)
    print('LINUX_WEBKIT_AVATAR_MINIMUM_LAYOUT_AND_OFFLINE_GUARD_OK', flush=True)

    click('Skin 00')
    library_before, capes_before = bounds(wait('Библиотека скинов')), bounds(wait('Гардероб плащей'))
    x, y, width, height = library_before
    subprocess.run(['xdotool', 'mousemove', str(x + width // 2), str(y + height // 2),
                    'click', '--repeat', '8', '--delay', '80', '5'], check=True)
    click('Skin 20')
    wait('Skin 20')
    assert bounds(wait('Библиотека скинов')) == library_before, 'skin wheel moved the whole page'
    assert bounds(wait('Гардероб плащей')) == capes_before, 'cape panel moved while scrolling skins'
    saved = json.loads((data / 'settings.json').read_text(encoding='utf-8'))
    assert len(saved['skin_presets']) == 24 and saved['skin_favorites'][0]['futureField'] == 'preserved'
    assert skin.is_file()
    print('LINUX_WEBKIT_NESTED_SCROLL_SELECTION_AND_USER_DATA_OK', flush=True)
except Exception:
    traceback.print_exc()
    log.flush()
    print('APP_LOG_TAIL', (root / 'launcher.log').read_text(errors='replace')[-5000:], flush=True)
    raise
finally:
    if proc:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    log.close()
    shutil.rmtree(root, ignore_errors=True)
