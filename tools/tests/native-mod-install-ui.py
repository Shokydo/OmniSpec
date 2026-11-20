#!/usr/bin/env python3
"""Exercise real Tauri/WebKit mod-install UI against live APIs on Linux.

Run a *debug* omnispec-app inside Xvfb; requires python websocket-client and
network access. Uses a fresh throwaway OMNISPEC_HOME, never a real user profile.
Example: xvfb-run -a python3 tools/tests/native-mod-install-ui.py target/debug/omnispec-app
"""
import hashlib
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
root = pathlib.Path(tempfile.mkdtemp(prefix="omnispec-native-mod-ui-"))
data = root / "data"
fixtures = ["mr-home", "mr-inside", "cf-home", "cf-inside"]
for ident in fixtures:
    inst = data / "instances" / ident
    (inst / "minecraft").mkdir(parents=True)
    (inst / "instance.json").write_text(json.dumps({
        "id": ident, "name": ident, "mc_version": "1.21.1",
        "loader": {"type": "fabric", "version": "0.16.10"}
    }), encoding="utf-8")
(data / "settings.json").write_text(json.dumps({
    "onboarded": True, "ambient": "off", "click_fx": "off", "update_enabled": False,
    "discord_rpc": False, "feed_grid": 1, "theme": "dark"
}), encoding="utf-8")
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
env = os.environ.copy()
env.update({"OMNISPEC_HOME": str(data), "WEBKIT_INSPECTOR_HTTP_SERVER": f"127.0.0.1:{port}",
            "WEBKIT_DISABLE_COMPOSITING_MODE": "1"})
for key in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
    env[key] = str(root / key)
    pathlib.Path(env[key]).mkdir()
log = (root / "launcher.log").open("w", encoding="utf-8")
p = subprocess.Popen([str(app)], stdout=log, stderr=log, env=env)
ws = None
try:
    match = None
    for _ in range(400):
        if p.poll() is not None:
            raise RuntimeError(f"launcher exited before inspector: {p.returncode}")
        try:
            html = urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1).read().decode()
            match = re.search(r"(/socket/[^']+)", html)
            if match and "tauri://localhost" in html:
                break
        except Exception:
            pass
        time.sleep(.15)
    if not match:
        raise RuntimeError("WebKit inspector unavailable (use a debug build)")
    ws = websocket.create_connection(f"ws://127.0.0.1:{port}" + match.group(1), timeout=20,
                                     origin=f"http://127.0.0.1:{port}")
    ws.send(json.dumps({"id": 1, "method": "Target.setPauseOnStart", "params": {"pauseOnStart": False}}))
    target = None
    for _ in range(50):
        msg = json.loads(ws.recv())
        if msg.get("method") == "Target.targetCreated":
            target = msg["params"]["targetInfo"]["targetId"]
            break
    assert target, "no WebKit target"
    serial = [1]

    def evaluate(expression):
        serial[0] += 1
        sid = serial[0]
        inner = {"id": sid, "method": "Runtime.evaluate",
                 "params": {"expression": expression, "returnByValue": True}}
        ws.send(json.dumps({"id": 100000 + sid, "method": "Target.sendMessageToTarget",
                            "params": {"targetId": target, "message": json.dumps(inner)}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 100000 + sid and "error" in msg:
                raise RuntimeError(msg["error"])
            if msg.get("method") != "Target.dispatchMessageFromTarget":
                continue
            response = json.loads(msg["params"]["message"])
            if response.get("id") != sid:
                continue
            if "error" in response or response.get("result", {}).get("wasThrown"):
                raise RuntimeError(response)
            return response["result"]["result"].get("value")

    def get(expression):
        return json.loads(evaluate("JSON.stringify(" + expression + ")"))

    def wait(expression, timeout=100):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if p.poll() is not None:
                raise RuntimeError(f"LAUNCHER_CLOSED_EXIT {p.returncode}")
            if get("Boolean(" + expression + ")"):
                return
            time.sleep(.2)
        detail = get("({tab:window.omnispecDebug?.state?.selectedId,toasts:document.querySelector('#toasts')?.innerText,modal:document.querySelector('#modal-mod-target')?.innerText,results:document.querySelector('#dv-results, #mr-results, #cf-results')?.innerText.slice(0,900)})")
        raise TimeoutError(f"{expression}; UI={detail}")

    def click(selector):
        wait("document.querySelector(" + json.dumps(selector) + ")")
        evaluate("document.querySelector(" + json.dumps(selector) + ").click(); true")

    def change(selector, value, event="input"):
        wait("document.querySelector(" + json.dumps(selector) + ")")
        evaluate("(()=>{const e=document.querySelector(%s);e.value=%s;e.dispatchEvent(new Event(%s,{bubbles:true}));return true})()" %
                 (json.dumps(selector), json.dumps(value), json.dumps(event)))

    projects = {"modrinth": ("P7dR8mSH", "data-project", "data-install"),
                "curseforge": ("306612", "data-cf-project", "data-cf-install")}

    def home_project(source):
        click("#btn-home")
        wait("window.omnispecDebug.state.selectedId === null")
        click('[data-dv-type="mod"]')
        click('[data-dv-source="%s"]' % source)
        change("#dv-query", "Fabric API")
        ident, attr, button = projects[source]
        selector = '#dv-results [%s="%s"] [%s]' % (attr, ident, button)
        wait("document.querySelector(%s)" % json.dumps(selector), 120)
        click(selector)
        wait("!document.querySelector('#modal-mod-target').hidden")

    def file_result(ident, source):
        directory = data / "instances" / ident
        manifest = directory / "content.json"
        if not manifest.exists():
            return None
        try:
            records = json.loads(manifest.read_text(encoding="utf-8"))["files"]
            rec = next(r for r in records.values() if r.get("project_id") == projects[source][0]
                       and r.get("source") == source)
            jar = directory / "minecraft" / "mods" / rec["filename"]
            if not jar.is_file() or jar.stat().st_size < 100_000:
                return None
            digest = hashlib.sha1(jar.read_bytes()).hexdigest()
            if not rec.get("sha1") or digest != rec["sha1"].lower():
                raise AssertionError("downloaded JAR does not match recorded SHA-1")
            return jar.name, jar.stat().st_size, digest
        except (OSError, json.JSONDecodeError, KeyError, StopIteration):
            return None

    def await_file(ident, source, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if p.poll() is not None:
                raise RuntimeError(f"LAUNCHER_CLOSED_EXIT {p.returncode}")
            result = file_result(ident, source)
            if result:
                # Let the async command, final UI update, and any error handling finish.
                time.sleep(1)
                if p.poll() is not None:
                    raise RuntimeError(f"LAUNCHER_CLOSED_EXIT {p.returncode}")
                return result
            time.sleep(.25)
        detail = get("({toasts:document.querySelector('#toasts')?.innerText,downloads:window.omnispecDebug?.state?.downloads})")
        raise TimeoutError(f"no verified file for {source}/{ident}; UI={detail}")

    wait("window.omnispecDebug?.state?.settings?.onboarded && window.omnispecDebug.state.instances.length === 4", 120)
    print(f"NATIVE_UI_STARTED pid={p.pid}", flush=True)
    for source in ("modrinth", "curseforge"):
        home = "mr-home" if source == "modrinth" else "cf-home"
        inside = "mr-inside" if source == "modrinth" else "cf-inside"
        home_project(source)
        radio = 'input[name="mod-target-instance"][value="%s"]' % home
        wait("document.querySelector(%s) && !document.querySelector(%s).disabled" % (json.dumps(radio), json.dumps(radio)), 120)
        click(radio)
        wait("!document.querySelector('#mod-target-submit').disabled")
        click("#mod-target-submit")
        print("NATIVE_HOME_EXISTING", source, await_file(home, source), "process-alive=true", flush=True)

        home_project(source)
        click("#mod-target-create")
        wait("document.querySelector('#mod-target-mc option[value=\"1.21.1\"]')", 120)
        change("#mod-target-mc", "1.21.1", "change")
        wait("document.querySelector('#mod-target-loader option[value=\"fabric\"]')", 120)
        if get("document.querySelector('#mod-target-loader').value") != "fabric":
            change("#mod-target-loader", "fabric", "change")
        name = "Native " + source + " new"
        change("#mod-target-name", name)
        wait("document.querySelector('#mod-target-submit') && !document.querySelector('#mod-target-submit').disabled", 120)
        click("#mod-target-submit")
        wait("window.omnispecDebug.state.instances.some(x=>x.name===%s)" % json.dumps(name), 180)
        ident = get("window.omnispecDebug.state.instances.find(x=>x.name===%s).id" % json.dumps(name))
        print("NATIVE_HOME_CREATE", source, ident, await_file(ident, source), "process-alive=true", flush=True)

        click("#btn-home")
        click('[data-home-id="%s"]' % inside)
        click('[data-tab="download"]')
        click('[data-dl-source="%s"]' % source)
        change("#dl-query", "Fabric API")
        ident, attr, button = projects[source]
        container = "#mr-results" if source == "modrinth" else "#cf-results"
        selector = '%s [%s="%s"] [%s]' % (container, attr, ident, button)
        wait("document.querySelector(%s)" % json.dumps(selector), 120)
        click(selector)
        print("NATIVE_INSIDE", source, await_file(inside, source), "process-alive=true", flush=True)

    # Invalid metadata must reject normally rather than terminate the process.
    evaluate("window.__badInstall=null;window.__TAURI__.core.invoke('install_mod',{instanceId:'mr-home',projectId:'not-a-real-project-omnispec-test',opId:'install:error-test'}).then(v=>window.__badInstall={ok:true}).catch(e=>window.__badInstall={ok:false,error:String(e)});true")
    wait("window.__badInstall !== null", 90)
    error = get("window.__badInstall")
    assert not error["ok"] and error.get("error"), error
    assert p.poll() is None
    print("NATIVE_ERROR_REJECTED_PROCESS_ALIVE", error["error"][:160], flush=True)
except Exception:
    traceback.print_exc()
    print("DIAGNOSTIC_DIRECTORY", root, "EXIT", p.poll(), flush=True)
    raise
finally:
    if ws:
        ws.close()
    if p.poll() is None:
        p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    log.close()
    if sys.exc_info()[0] is None and not os.environ.get("OMNISPEC_KEEP_TEST_DATA"):
        shutil.rmtree(root, ignore_errors=True)
