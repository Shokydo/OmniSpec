#!/usr/bin/env python3
"""Exercise the actual launch/recovery path with a tiny Java fixture, NOT Minecraft.

Run with Xvfb and a debug Tauri build; requires JDK 11+ and websocket-client.
The only data used is a disposable launcher profile and a locally built JAR.
"""
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import zipfile

import websocket

app = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'target/debug/omnispec-app').resolve(strict=True)
java = pathlib.Path(shutil.which('java') or '').resolve(strict=True)
javac = pathlib.Path(shutil.which('javac') or '').resolve(strict=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='omnispec-native-launch-'))
data = root / 'data'
inst = data / 'instances' / 'fixture'
game = inst / 'minecraft'
version = data / 'meta' / 'versions' / 'fixture'
for path in (game, version): path.mkdir(parents=True)
(inst / 'instance.json').write_text(json.dumps({'id':'fixture', 'name':'Fixture Game',
    'mc_version':'fixture', 'loader':{'type':'vanilla'}, 'playtime_secs':0}), encoding='utf-8')
(data / 'settings.json').write_text(json.dumps({'onboarded':True, 'update_enabled':False,
    'discord_rpc':False, 'ambient':'off', 'click_fx':'off', 'theme':'dark', 'auto_java':False,
    'java_path':str(java), 'memory_mb':512, 'jvm_args':''}), encoding='utf-8')
source = root / 'FakeGame.java'
source.write_text('''
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
public class FakeGame {
  public static void main(String[] args) throws Exception {
    Files.writeString(Path.of("fakegame.pid"), Long.toString(ProcessHandle.current().pid()), StandardCharsets.UTF_8);
    for (int i = 0; i < 600; i++) {
      Files.writeString(Path.of("fakegame.heartbeat"), Integer.toString(i), StandardCharsets.UTF_8);
      System.out.println("fake-game-stdout " + i);
      System.err.println("fake-game-stderr " + i);
      Thread.sleep(500);
    }
  }
}
''', encoding='utf-8')
subprocess.run([str(javac), '-d', str(root), str(source)], check=True, timeout=30)
jar = version / 'fixture.jar'
with zipfile.ZipFile(jar, 'w', compression=zipfile.ZIP_DEFLATED) as out:
    out.write(root / 'FakeGame.class', 'FakeGame.class')
(version / 'fixture.json').write_text(json.dumps({'id':'fixture', 'type':'release',
    'mainClass':'FakeGame', 'javaVersion':{'majorVersion':11},
    'downloads':{'client':{'url':'http://127.0.0.1:1/not-used.jar', 'size':jar.stat().st_size}},
    'libraries':[], 'arguments':{'jvm':['-cp','${classpath}'], 'game':['--fixture']}}), encoding='utf-8')

class App:
    def __init__(self, n):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port=sock.getsockname()[1]
        env=os.environ.copy()
        env.update({'OMNISPEC_HOME':str(data), 'WEBKIT_DISABLE_COMPOSITING_MODE':'1',
                    'WEBKIT_INSPECTOR_HTTP_SERVER':f'127.0.0.1:{self.port}'})
        for key in ('XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'):
            env[key]=str(root/key);pathlib.Path(env[key]).mkdir(exist_ok=True)
        self.log=(root/f'launcher-{n}.log').open('w')
        self.proc=subprocess.Popen([str(app)],stdout=self.log,stderr=self.log,env=env)
        self.ws=None
        match=None
        for _ in range(400):
            self.alive()
            try:
                html=urllib.request.urlopen(f'http://127.0.0.1:{self.port}/',timeout=1).read().decode()
                match=re.search(r"(/socket/[^']+)",html)
                if match and 'tauri://localhost' in html: break
            except Exception: pass
            time.sleep(.15)
        if not match: raise RuntimeError('debug WebKit inspector unavailable')
        self.ws=websocket.create_connection(f'ws://127.0.0.1:{self.port}'+match.group(1),timeout=20,
                                            origin=f'http://127.0.0.1:{self.port}')
        self.ws.send(json.dumps({'id':1,'method':'Target.setPauseOnStart','params':{'pauseOnStart':False}}))
        self.target=None
        for _ in range(50):
            msg=json.loads(self.ws.recv())
            if msg.get('method')=='Target.targetCreated':self.target=msg['params']['targetInfo']['targetId'];break
        assert self.target
        self.serial=1
    def alive(self):
        if self.proc.poll() is not None: raise RuntimeError(f'launcher exited unexpectedly: {self.proc.returncode}')
    def evaluate(self, expression):
        self.serial+=1; n=self.serial
        inner={'id':n,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True}}
        self.ws.send(json.dumps({'id':100000+n,'method':'Target.sendMessageToTarget',
                                 'params':{'targetId':self.target,'message':json.dumps(inner)}}))
        while True:
            msg=json.loads(self.ws.recv())
            if msg.get('id')==100000+n and 'error' in msg: raise RuntimeError(msg['error'])
            if msg.get('method')!='Target.dispatchMessageFromTarget':continue
            res=json.loads(msg['params']['message'])
            if res.get('id')!=n:continue
            if 'error' in res or res.get('result',{}).get('wasThrown'):raise RuntimeError(res)
            return res['result']['result'].get('value')
    def get(self, expression): return json.loads(self.evaluate('JSON.stringify('+expression+')'))
    def wait(self, expression, timeout=60):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            self.alive()
            if self.get('Boolean('+expression+')'):return
            time.sleep(.2)
        raise TimeoutError(expression)
    def close_window(self):
        self.evaluate("setTimeout(()=>window.__TAURI__.core.invoke('window_action',{action:'close'}),200); true")
        code=self.proc.wait(timeout=15)
        assert code==0, f'normal window close returned {code}'
        if self.ws:self.ws.close();self.ws=None
        self.log.close()
    def close(self):
        if self.ws:self.ws.close();self.ws=None
        if self.proc.poll() is None:self.proc.terminate()
        try:self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        if not self.log.closed:self.log.close()

def wait_disk(condition, timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            value=condition()
            if value:return value
        except (OSError,ValueError,KeyError):pass
        time.sleep(.1)
    raise TimeoutError('fixture files did not settle')

def live(pid):
    try:
        tail=pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1]
        return tail.split()[0] not in ('Z','X','x')
    except OSError:return False

def meta():return json.loads((inst/'instance.json').read_text())
apps=[]; pid=None
try:
    one=App(1); apps.append(one)
    one.wait("document.querySelector('.instance[data-id=fixture]')",120)
    one.evaluate("document.querySelector('.instance[data-id=fixture]').click(); true")
    one.wait("window.omnispecDebug?.state?.selectedId === 'fixture'")
    one.evaluate("document.querySelector('#btn-play').click(); true")
    one.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 1",90)
    pid=int(wait_disk(lambda:(game/'fakegame.pid').read_text().strip()))
    assert live(pid), 'launched Java process is not running'
    journal=wait_disk(lambda:list((data/'running-sessions').glob('*.json')))
    assert len(journal)==1
    record=json.loads(journal[0].read_text())
    assert record['process']['pid']==pid and record['instance_id']=='fixture'
    beat=int(wait_disk(lambda:(game/'fakegame.heartbeat').read_text().strip()))
    print('NATIVE_LAUNCH_JAVA_FIXTURE_STARTED_AND_REGISTERED',pid,flush=True)

    one.close_window()
    assert live(pid),'closing launcher killed its launched Java child'
    wait_disk(lambda:int((game/'fakegame.heartbeat').read_text().strip())>beat+2,20)
    assert live(pid),'Java child stopped while writing after launcher closed'
    print('NATIVE_LAUNCH_JAVA_FIXTURE_SURVIVED_CLOSED_LAUNCHER',flush=True)

    two=App(2); apps.append(two)
    two.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 1",120)
    two.wait("document.querySelector('.instance[data-id=fixture]')")
    two.evaluate("document.querySelector('.instance[data-id=fixture]').click(); true")
    two.wait("window.omnispecDebug?.state?.selectedId === 'fixture'")
    two.evaluate("document.querySelector('#btn-stop').click(); true")
    wait_disk(lambda:not live(pid),20)
    two.wait("!window.omnispecDebug?.state?.sessions?.has('fixture')",30)
    wait_disk(lambda:not journal[0].exists(),30)
    seconds=meta()['playtime_secs']
    assert seconds > 0 and seconds <= int(time.time())-record['started_at']+5,(seconds,record)
    assert not meta().get('_omnispec_playtime_checkpoints')
    two.close_window()
    three=App(3);apps.append(three)
    three.wait("window.omnispecDebug?.state?.instances?.some(i=>i.id==='fixture')",120)
    assert not three.get("window.omnispecDebug.state.sessions.has('fixture')")
    assert meta()['playtime_secs']==seconds, 'restart double-counted playtime'
    three.close_window()
    print('NATIVE_LAUNCH_JAVA_FIXTURE_RECOVERED_STOPPED_AND_COUNTED_ONCE',seconds,flush=True)
except Exception:
    traceback.print_exc()
    print('DIAGNOSTICS',root,flush=True)
    for a in apps:
        try: print('STATE',a.get("({selected:window.omnispecDebug?.state?.selectedId,logs:window.omnispecDebug?.state?.logs?.fixture})"),flush=True)
        except Exception:pass
    raise
finally:
    for a in apps:
        try:a.close()
        except Exception:pass
    if pid and live(pid):
        try:os.kill(pid,signal.SIGKILL)
        except OSError:pass
