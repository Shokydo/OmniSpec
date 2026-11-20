#!/usr/bin/env python3
"""Real Tauri/WebKitGTK + fake Discord IPC, isolated data and X11.
Run with: dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' python3 ...
No real Discord or user profile is touched. Windows has a separate test.
"""
import ctypes
import glob
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback

sys.path.append('/usr/lib/python3/dist-packages')
import pyatspi
from PIL import Image, ImageChops, ImageStat

repo = pathlib.Path(__file__).resolve().parents[2]
binary = pathlib.Path(os.environ.get('LAUNCHER_ICON_BINARY', str(repo / 'target/debug/omnispec-app')))
if glob.glob('/tmp/discord-ipc-*'):
    raise RuntimeError('Refusing to run while a real global Discord IPC socket exists')
root = pathlib.Path(tempfile.mkdtemp(prefix='omnispec-launcher-icon-'))
data, home, runtime = [root / name for name in ('data', 'home', 'runtime')]
for directory in (data, home, runtime): directory.mkdir()
runtime.chmod(0o700)
settings_file = data / 'settings.json'
settings_file.write_text(json.dumps({'onboarded': True, 'update_enabled': False, 'discord_rpc': True,
    'discord_instance_icon': False, 'discord_upload_local_icon': False, 'click_fx': 'off',
    'ambient': 'off', 'trail': False, 'trail_style': 'sparks', 'sound_fx': False, 'ui_scale': 100,
    'username': 'IconFixture'}), encoding='utf-8')

class FakeDiscord:
    def __init__(self):
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(runtime / 'discord-ipc-0'))
        self.server.listen(3)
        self.server.settimeout(0.3)
        self.events = []
        self.lock = threading.Lock()
        self.done = False
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
    @staticmethod
    def read_exact(conn, length):
        result = b''
        while len(result) < length:
            part = conn.recv(length-len(result))
            if not part: raise EOFError()
            result += part
        return result
    @classmethod
    def read(cls, conn):
        opcode, length = struct.unpack('<II', cls.read_exact(conn, 8))
        if length > 1024*1024: raise ValueError('oversized frame')
        return opcode, json.loads(cls.read_exact(conn, length))
    @staticmethod
    def write(conn, opcode, data):
        raw = json.dumps(data).encode('utf-8')
        conn.sendall(struct.pack('<II', opcode, len(raw)) + raw)
    def run(self):
        try:
            while not self.done:
                try: conn, _ = self.server.accept()
                except socket.timeout: continue
                except OSError: break
                with conn:
                    try:
                        opcode, handshake = self.read(conn)
                        assert opcode == 0 and handshake['client_id'] == '1304864863830540439'
                        self.write(conn, 1, {'evt': 'READY'})
                        while not self.done:
                            opcode, message = self.read(conn)
                            if opcode == 1 and message.get('cmd') == 'SET_ACTIVITY':
                                with self.lock: self.events.append(message['args']['activity'])
                    except (EOFError, ConnectionResetError, BrokenPipeError):
                        pass
        except Exception as error:
            self.error = repr(error)
    def count(self):
        with self.lock: return len(self.events)
    def wait_icon(self, suffix, start=0, timeout=15):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            if self.error: raise RuntimeError('Fake IPC: '+self.error)
            with self.lock: events = self.events[start:]
            for activity in events:
                if activity and activity.get('assets', {}).get('large_image', '').endswith(suffix):
                    assert 'small_image' not in activity['assets'], 'disabled small icon leaked'
                    return activity
            time.sleep(.1)
        raise AssertionError(f'No IPC activity {suffix}, recent={events[-4:]}')
    def stop(self):
        self.done = True
        self.server.close()
        self.thread.join(timeout=2)

fake = FakeDiscord()
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

def wait_node(name, timeout=60):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        node=find(name)
        if node: return node
        if proc and proc.poll() is not None: raise RuntimeError('launcher exited '+str(proc.returncode))
        time.sleep(.15)
    raise AssertionError('accessible element not found: '+name)

def wait_checked(name, timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        node=find(name)
        try:
            if node and node.getState().contains(pyatspi.STATE_CHECKED): return
        except Exception: pass
        time.sleep(.1)
    raise AssertionError('radio not checked: '+name)

def action(name):
    node=wait_node(name)
    a=node.queryAction()
    if not a.nActions or not a.doAction(0): raise RuntimeError('cannot invoke '+name+' role='+node.getRoleName())

def saved(): return json.loads(settings_file.read_text(encoding='utf-8'))

def wait_saved(icon, timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            if saved().get('launcher_icon')==icon: return
        except Exception: pass
        time.sleep(.1)
    raise AssertionError('not saved: '+icon)

def launch():
    global proc, log
    env={**os.environ, 'HOME':str(home), 'XDG_CONFIG_HOME':str(home/'.config'),
         'XDG_CACHE_HOME':str(home/'.cache'), 'XDG_DATA_HOME':str(home/'.local/share'),
         'XDG_RUNTIME_DIR':str(runtime), 'OMNISPEC_HOME':str(data),
         'WEBKIT_DISABLE_COMPOSITING_MODE':'1', 'WEBKIT_DISABLE_DMABUF_RENDERER':'1'}
    log=(root/'launcher.log').open('a')
    proc=subprocess.Popen([str(binary)], stdout=log, stderr=log, env=env)
    wait_node('Настройки',90)

def stop():
    global proc, log
    if proc:
        proc.terminate()
        try: proc.wait(timeout=8)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
        proc=None
    if log: log.close();log=None
    time.sleep(.5)

x11=ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.argtypes=[ctypes.c_char_p]; x11.XOpenDisplay.restype=ctypes.c_void_p
x11.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int]; x11.XInternAtom.restype=ctypes.c_ulong
x11.XGetWindowProperty.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_long,ctypes.c_long,
    ctypes.c_int,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.c_ulong),ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
x11.XGetWindowProperty.restype=ctypes.c_int
x11.XFree.argtypes=[ctypes.c_void_p]
display=x11.XOpenDisplay(None)
if not display: raise RuntimeError('X11 display is unavailable')
atom=x11.XInternAtom(display,b'_NET_WM_ICON',0)

def window_icon():
    tree=subprocess.check_output(['xwininfo','-root','-tree'],text=True)
    ids=re.findall(r'(?m)^\s*(0x[0-9a-fA-F]+)\s+"OmniSpec"',tree)
    for wid in ids:
        actual=ctypes.c_ulong();fmt=ctypes.c_int();n=ctypes.c_ulong();remaining=ctypes.c_ulong()
        ptr=ctypes.POINTER(ctypes.c_ubyte)()
        code=x11.XGetWindowProperty(display,int(wid,16),atom,0,1000000,0,0,ctypes.byref(actual),
            ctypes.byref(fmt),ctypes.byref(n),ctypes.byref(remaining),ctypes.byref(ptr))
        if code or not ptr: continue
        try:
            if fmt.value != 32 or n.value < 3: continue
            values=ctypes.cast(ptr,ctypes.POINTER(ctypes.c_ulong))
            offset=0; images=[]
            while offset+2 <= n.value:
                w,h=int(values[offset]),int(values[offset+1]);offset+=2
                if w<1 or h<1 or w*h>1000000 or offset+w*h>n.value: break
                rgba=bytearray()
                for i in range(w*h):
                    pixel=int(values[offset+i])
                    rgba.extend(((pixel>>16)&255,(pixel>>8)&255,pixel&255,(pixel>>24)&255))
                images.append(Image.frombytes('RGBA',(w,h),bytes(rgba)))
                offset+=w*h
            if images: return max(images,key=lambda im:im.width*im.height)
        finally: x11.XFree(ptr)
    return None

def image_distance(actual, expected):
    # Прозрачный оригинал и ARGB окна сравниваем на одинаковом чёрном фоне.
    expected=expected.convert('RGBA').resize(actual.size,Image.Resampling.LANCZOS)
    a=Image.new('RGBA',actual.size,(0,0,0,255)); a.alpha_composite(actual)
    b=Image.new('RGBA',expected.size,(0,0,0,255)); b.alpha_composite(expected)
    return sum(ImageStat.Stat(ImageChops.difference(a.convert('RGB'),b.convert('RGB'))).mean)/3

def wait_native(icon, timeout=15):
    file=(repo/'apps/omnispec-app/icons/icon-512.png' if icon=='default'
          else repo/f'apps/omnispec-app/ui/assets/launcher-icons/{icon}.png')
    expected=Image.open(file)
    deadline=time.monotonic()+timeout; distance=None
    while time.monotonic()<deadline:
        actual=window_icon()
        if actual:
            distance=image_distance(actual,expected)
            if distance<4.0:
                return (actual.size,round(distance,3),hashlib.sha256(actual.tobytes()).hexdigest()[:12])
        time.sleep(.15)
    raise AssertionError(f'native icon {icon} differs: distance={distance}')

try:
    launch()
    print('STARTUP_NATIVE', wait_native('default'), flush=True)
    fake.wait_icon('/icon-512.png')
    action('Настройки'); action('Оформление')
    for icon,name in [('ru','Россия'),('by','Беларусь'),('kz','Казахстан'),('ua','Украина'),('us','США')]:
        start=fake.count(); action(name); wait_saved(icon)
        result=wait_native(icon); fake.wait_icon('/'+icon+'.png',start)
        assert saved()['username']=='IconFixture' and saved()['discord_instance_icon'] is False
        print('LINUX_NATIVE_ICON_AND_FAKE_IPC_OK',icon,result,flush=True)

    # Создание временного файла settings запрещено: откат нативного значка и RPC.
    before=fake.count(); os.chmod(data,0o500)
    try:
        action('Россия')
        wait_checked('США', 15)
        time.sleep(.6)  # worker IPC должен успеть обработать возможное изменение
        assert saved()['launcher_icon']=='us'
        print('LINUX_NATIVE_SAVE_FAILURE_ROLLBACK',wait_native('us'),flush=True)
        with fake.lock:
            assert not any(a and a.get('assets',{}).get('large_image','').endswith('/ru.png') for a in fake.events[before:])
    finally: os.chmod(data,0o700)

    stop(); start=fake.count(); launch()
    assert saved()['launcher_icon']=='us'
    print('LINUX_NATIVE_RESTART',wait_native('us'),flush=True)
    fake.wait_icon('/us.png',start)
    action('Настройки');action('Оформление');action('Оригинал');wait_saved('default')
    print('LINUX_NATIVE_DEFAULT_RESTORE',wait_native('default'),flush=True)
    fake.wait_icon('/icon-512.png')
    print('LINUX_TAURI_ICON_RPC_AND_RESTART_OK',flush=True)
except Exception:
    traceback.print_exc()
    try:
        if log: log.flush()
        print('APP_LOG_TAIL', (root/'launcher.log').read_text(errors='replace')[-5000:], flush=True)
        subprocess.run(['import','-window','root',str(pathlib.Path(tempfile.gettempdir())/'omnispec-launcher-icon-linux-failure.png')],check=False,timeout=10)
        for node in walk(pyatspi.Registry.getDesktop(0)):
            try:
                if node.name and any(x in node.name for x in ('икон', 'Россия','США','Оформление')):
                    print('ACCESSIBLE_NODE',node.getRoleName(),repr(node.name),flush=True)
            except Exception: pass
    except Exception: pass
    raise
finally:
    os.chmod(data,0o700)
    stop();fake.stop();shutil.rmtree(root,ignore_errors=True)
