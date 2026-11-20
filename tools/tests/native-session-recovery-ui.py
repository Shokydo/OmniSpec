#!/usr/bin/env python3
"""Real Linux Tauri restart/recovery with synthetic processes, not Minecraft.

Run inside Xvfb with a debug build and python websocket-client. Uses only a
throwaway launcher profile. Two launcher processes concurrently observe one
profile, then a normal window close and a forced exit precede recovery. Tests
live and offline-dead sessions, safe stop, and no duplicate playtime.
"""
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
import websocket

app = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/omnispec-app").resolve(strict=True)
root = pathlib.Path(tempfile.mkdtemp(prefix="omnispec-native-session-"))
data = root / "data"
inst = data / "instances" / "fixture"
(inst / "minecraft").mkdir(parents=True)
(data / "running-sessions").mkdir()
(inst / "instance.json").write_text(json.dumps({"id":"fixture","name":"Fixture",
    "mc_version":"1.21.1","loader":{"type":"vanilla"},"playtime_secs":0}), encoding="utf-8")
(data / "settings.json").write_text(json.dumps({"onboarded":True,"update_enabled":False,
    "discord_rpc":False,"ambient":"off","click_fx":"off","theme":"dark"}), encoding="utf-8")
children = [subprocess.Popen([sys.executable, "-c", "import time;time.sleep(180)"]) for _ in range(3)]
now = int(time.time())
ids = ["fixture#" + letter * 32 for letter in "abc"]
starts = [now - 10, now - 6, now - 4]
boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
for proc, run_id, started in zip(children, ids, starts):
    stat = pathlib.Path(f"/proc/{proc.pid}/stat").read_text().rsplit(") ",1)[1].split()
    record = {"run_id":run_id,"instance_id":"fixture","account":"Fixture",
              "game_dir":str(inst / "minecraft"),"started_at":started,"checkpoint_at":started,
              "process":{"pid":proc.pid,"start":int(stat[19]),"boot":boot}}
    (data / "running-sessions" / (run_id.split("#")[1] + ".json")).write_text(json.dumps(record), encoding="utf-8")

class App:
    def __init__(self, n):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); self.port=sock.getsockname()[1]
        env=os.environ.copy()
        env.update({"OMNISPEC_HOME":str(data),"WEBKIT_DISABLE_COMPOSITING_MODE":"1",
                    "WEBKIT_INSPECTOR_HTTP_SERVER":f"127.0.0.1:{self.port}"})
        for key in ("XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME"):
            env[key]=str(root/key);pathlib.Path(env[key]).mkdir(exist_ok=True)
        self.log=(root/f"launcher-{n}.log").open("w")
        self.proc=subprocess.Popen([str(app)],stdout=self.log,stderr=self.log,env=env)
        self.ws=None
        match=None
        for _ in range(400):
            self.alive()
            try:
                html=urllib.request.urlopen(f"http://127.0.0.1:{self.port}/",timeout=1).read().decode()
                match=re.search(r"(/socket/[^']+)",html)
                if match and "tauri://localhost" in html:break
            except Exception:pass
            time.sleep(.15)
        if not match:raise RuntimeError("debug WebKit inspector unavailable")
        self.ws=websocket.create_connection(f"ws://127.0.0.1:{self.port}"+match.group(1),timeout=20,
                                            origin=f"http://127.0.0.1:{self.port}")
        self.ws.send(json.dumps({"id":1,"method":"Target.setPauseOnStart","params":{"pauseOnStart":False}}))
        self.target=None
        for _ in range(50):
            msg=json.loads(self.ws.recv())
            if msg.get("method")=="Target.targetCreated":self.target=msg["params"]["targetInfo"]["targetId"];break
        assert self.target
        self.serial=1
    def alive(self):
        if self.proc.poll() is not None:raise RuntimeError(f"launcher exited unexpectedly: {self.proc.returncode}")
    def evaluate(self, expression):
        self.serial+=1; n=self.serial
        inner={"id":n,"method":"Runtime.evaluate","params":{"expression":expression,"returnByValue":True}}
        self.ws.send(json.dumps({"id":100000+n,"method":"Target.sendMessageToTarget",
                                 "params":{"targetId":self.target,"message":json.dumps(inner)}}))
        while True:
            msg=json.loads(self.ws.recv())
            if msg.get("id")==100000+n and "error" in msg:raise RuntimeError(msg["error"])
            if msg.get("method")!="Target.dispatchMessageFromTarget":continue
            res=json.loads(msg["params"]["message"])
            if res.get("id")!=n:continue
            if "error" in res or res.get("result",{}).get("wasThrown"):raise RuntimeError(res)
            return res["result"]["result"].get("value")
    def get(self, expression):return json.loads(self.evaluate("JSON.stringify("+expression+")"))
    def wait(self, expression, timeout=60):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            self.alive()
            if self.get("Boolean("+expression+")"):return
            time.sleep(.2)
        raise TimeoutError(expression)
    def close_window(self):
        # Invoke the same backend action as the real close button. A timer lets
        # the inspector receive its reply before the WebView disappears.
        self.evaluate("setTimeout(()=>window.__TAURI__.core.invoke('window_action',{action:'close'}),200); true")
        code=self.proc.wait(timeout=15)
        assert code==0, f"normal window close returned {code}"
        if self.ws:
            try:self.ws.close()
            finally:self.ws=None
        self.log.close()
    def close(self):
        if self.ws:self.ws.close();self.ws=None
        if self.proc.poll() is None:self.proc.terminate()
        try:self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:self.proc.kill();self.proc.wait()
        self.log.close()

apps=[]
def wait_disk(condition, timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            result=condition()
            if result:return result
        except (OSError,ValueError,KeyError):pass
        time.sleep(.1)
    raise TimeoutError("session persistence did not settle")

def metadata():return json.loads((inst/"instance.json").read_text())
def journal(index):return json.loads((data/"running-sessions"/(ids[index].split("#")[1]+".json")).read_text())

try:
    one=App(1);apps.append(one)
    one.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 3",120)
    wait_disk(lambda: all(journal(i)["checkpoint_at"]>starts[i] for i in range(3))
              and len(metadata().get("_omnispec_playtime_checkpoints",{}))==3)
    two=App(2);apps.append(two)
    two.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 3",120)
    print("NATIVE_RECOVERY_TWO_LAUNCHERS_THREE_SESSIONS", ids, flush=True)

    # Both processes observe the same exit; only one may remove its journal and
    # clear the idempotency marker. The other must not recreate or recount it.
    children[2].terminate();children[2].wait(timeout=10)
    ended_c=int(time.time())
    one.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 2",60)
    two.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 2",60)
    wait_disk(lambda: not (data/"running-sessions"/("c"*32+".json")).exists())
    print("NATIVE_CONCURRENT_EXIT_ONCE",flush=True)

    one.close_window()
    assert all(child.poll() is None for child in children[:2]), "normal close must not stop games"
    two.close()  # simulate an abrupt launcher exit as well
    assert all(child.poll() is None for child in children[:2]), "launcher exit must not stop games"
    checkpoint_b=journal(1)["checkpoint_at"]
    children[1].terminate();children[1].wait(timeout=10)
    three=App(3);apps.append(three)
    three.wait("window.omnispecDebug?.state?.sessions?.get('fixture')?.size === 1",120)
    live=three.get("[...window.omnispecDebug.state.sessions.get('fixture').keys()]")
    assert live==[ids[0]],live
    wait_disk(lambda: not (data/"running-sessions"/("b"*32+".json")).exists())
    assert children[0].poll() is None
    print("NATIVE_RECOVERY_OFFLINE_EXIT", "only last saved checkpoint counted", flush=True)
    three.evaluate("window.__stopResult=null;window.__TAURI__.core.invoke('stop_instance',{instanceId:'fixture',runId:%s}).then(()=>window.__stopResult={ok:true}).catch(e=>window.__stopResult={ok:false,error:String(e)});true"%json.dumps(ids[0]))
    three.wait("window.__stopResult !== null")
    assert three.get("window.__stopResult")["ok"]
    children[0].wait(timeout=15)
    stopped=int(time.time())
    three.wait("!window.omnispecDebug.state.sessions.has('fixture')",60)
    wait_disk(lambda: not (data/"running-sessions"/("a"*32+".json")).exists())
    final=metadata()["playtime_secs"]
    expected=(stopped-starts[0])+(checkpoint_b-starts[1])+(ended_c-starts[2])
    assert abs(final-expected)<=5,(final,expected)
    assert not metadata().get("_omnispec_playtime_checkpoints"),metadata()
    three.alive();three.close()
    four=App(4);apps.append(four)
    four.wait("window.omnispecDebug?.state?.settings?.onboarded && window.omnispecDebug.state.instances.length === 1",120)
    time.sleep(1)
    assert four.get("window.omnispecDebug.state.sessions.size")==0
    assert metadata()["playtime_secs"]==final
    print("NATIVE_RECOVERY_SAFE_STOP_AND_NO_DOUBLE_COUNT", "seconds",final,"expected",expected,flush=True)
except Exception:
    traceback.print_exc();print("DIAGNOSTIC_DIRECTORY",root,flush=True);raise
finally:
    for item in apps:
        try:item.close()
        except Exception:pass
    for child in children:
        if child.poll() is None:child.kill();child.wait()
    if sys.exc_info()[0] is None and not os.environ.get("OMNISPEC_KEEP_TEST_DATA"):
        shutil.rmtree(root,ignore_errors=True)
