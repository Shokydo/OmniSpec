#!/usr/bin/env python3
"""Exercise five locales through the real Linux Tauri/WebKit and settings file.

Run: dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' python3 tools/tests/language-linux-native.py
The temporary profile is isolated; no real account, wallpaper or Discord is touched.
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
binary = pathlib.Path(os.environ.get('LANGUAGE_BINARY', repo / 'target/debug/omnispec-app'))
root = pathlib.Path(tempfile.mkdtemp(prefix='omnispec-language-'))
data, home, runtime = [root / x for x in ('data', 'home', 'runtime')]
for directory in (data, home, runtime): directory.mkdir()
runtime.chmod(0o700)
settings_file = data / 'settings.json'
settings_file.write_text(json.dumps({
    'onboarded':True, 'update_enabled':False, 'discord_rpc':False, 'click_fx':'off',
    'ambient':'off', 'trail':False, 'trail_style':'sparks', 'sound_fx':False, 'ui_scale':125,
    'username':'NativeFixture', 'launcher_icon':'kz', 'wallpaper':'workshop',
    'wallpaper_workshop_project':'/old/steam/do-not-delete', 'wallpaper_workshop_audio':True,
    'skin_presets':[{'id':'old','name':'Скин','path':'/old/skin.png'}]
},ensure_ascii=False),encoding='utf-8')
proc = None
log = None

def walk(node):
    yield node
    try:
        for child in node: yield from walk(child)
    except Exception: pass

def find(name):
    for node in walk(pyatspi.Registry.getDesktop(0)):
        try:
            if node.name == name and node.getState().contains(pyatspi.STATE_SHOWING): return node
        except Exception: pass
    return None

def wait_node(name, timeout=30):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        node=find(name)
        if node: return node
        if proc and proc.poll() is not None: raise RuntimeError(f'launcher exited: {proc.returncode}')
        time.sleep(.1)
    raise AssertionError(f'accessible element not found: {name!r}')

def action(name):
    node=wait_node(name)
    actions=node.queryAction()
    if not actions.nActions or not actions.doAction(0):
        raise RuntimeError(f'cannot invoke {name!r}, role={node.getRoleName()}')

def wait_text(fragment, timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        for node in walk(pyatspi.Registry.getDesktop(0)):
            try:
                if not node.getState().contains(pyatspi.STATE_SHOWING): continue
                if fragment in (node.name or ''): return
                text=node.queryText()
                if fragment in text.getText(0,text.characterCount): return
            except Exception: pass
        time.sleep(.1)
    raise AssertionError(f'accessible text not found: {fragment!r}')

def saved(): return json.loads(settings_file.read_text(encoding='utf-8'))

def wait_saved(language, timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            if saved().get('language') == language: return
        except Exception: pass
        time.sleep(.1)
    raise AssertionError(f'language was not saved: {language}')

def launch(settings_label):
    global proc, log
    env={**os.environ, 'HOME':str(home), 'XDG_CONFIG_HOME':str(home/'.config'),
         'XDG_CACHE_HOME':str(home/'.cache'), 'XDG_DATA_HOME':str(home/'.local/share'),
         'XDG_RUNTIME_DIR':str(runtime), 'OMNISPEC_HOME':str(data),
         'WEBKIT_DISABLE_COMPOSITING_MODE':'1', 'WEBKIT_DISABLE_DMABUF_RENDERER':'1'}
    log=(root/'launcher.log').open('a')
    proc=subprocess.Popen([str(binary)],stdout=log,stderr=log,env=env)
    wait_node(settings_label,90)

def stop():
    global proc, log
    if proc:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        proc=None
    if log: log.close();log=None
    time.sleep(.4)

try:
    launch('Настройки')
    action('Настройки');action('Оформление')
    for code,option,appearance in [
        ('be','Беларуская','Афармленне'),('kk','Қазақша','Сыртқы көрініс'),
        ('uk','Українська','Оформлення'),('en','English','Appearance'),('ru','Русский','Оформление'),
        ('en','English','Appearance')
    ]:
        action(option);wait_saved(code);wait_node(appearance)
        # Country names never depend on the interface locale.
        for country in ('Россия','Беларусь','Қазақстан','Україна','USA'): wait_node(country)
        print('LINUX_WEBKIT_LANGUAGE_OK',code,flush=True)

    # A failed write restores the last confirmed locale in the real WebView.
    os.chmod(data,0o500)
    try:
        action('Русский');wait_text('Failed to save language');wait_node('Appearance')
        assert saved()['language']=='en'
        print('LINUX_WEBKIT_LANGUAGE_SAVE_FAILURE_ROLLBACK_OK',flush=True)
    finally:
        os.chmod(data,0o700)

    stop();launch('Settings');action('Settings');action('Appearance')
    wait_node('Language');wait_node('Қазақстан')
    result=saved()
    assert result['language']=='en' and result['launcher_icon']=='kz'
    assert result['username']=='NativeFixture' and result['ui_scale']==125
    assert result['wallpaper']=='workshop' and result['wallpaper_workshop_audio'] is True
    assert result['wallpaper_workshop_project']=='/old/steam/do-not-delete'
    assert result['skin_presets'][0]['name']=='Скин'
    print('LINUX_WEBKIT_LANGUAGE_RESTART_AND_USER_DATA_OK',flush=True)
except Exception:
    traceback.print_exc()
    if log: log.flush()
    try: print('APP_LOG_TAIL', (root/'launcher.log').read_text(errors='replace')[-5000:],flush=True)
    except Exception: pass
    raise
finally:
    os.chmod(data,0o700)
    stop()
    shutil.rmtree(root,ignore_errors=True)
