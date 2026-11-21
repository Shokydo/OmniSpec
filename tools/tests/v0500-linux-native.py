#!/usr/bin/env python3
"""Real Linux Tauri/WebKitGTK, local WAV decoding and settings, isolated profile.

Requires a debug build, python websocket-client, dbus, Xvfb and xdotool:
  dbus-run-session -- xvfb-run -a -s '-screen 0 1440x900x24' \
    python3 tools/tests/v0500-linux-native.py
No licensed Minecraft account or live Minecraft launch is involved.
"""
import json, math, os, pathlib, re, shutil, socket, struct, subprocess, sys, tempfile, time, traceback, urllib.request, wave
import websocket

repo = pathlib.Path(__file__).resolve().parents[2]
source_binary = pathlib.Path(os.environ.get('V0500_BINARY', repo / 'target/debug/omnispec-app')).resolve(strict=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='omnispec-v0500-linux-'))
# A fresh profile enables auto-updates. Run a disposable copy so even an
# unexpected future update can never replace the developer's build output.
binary = root / 'OmniSpec-debug'
shutil.copy2(source_binary, binary)
binary.chmod(0o755)
data, home, runtime = (root / x for x in ('data','home','runtime'))
for directory in (data,home,runtime): directory.mkdir()
runtime.chmod(0o700)
settings_file = data/'settings.json'
# Intentionally absent at first launch: exercise real creation of a new profile.
original=root/'event tone.wav'
with wave.open(str(original),'wb') as f:
    f.setnchannels(1);f.setsampwidth(2);f.setframerate(44100)
    f.writeframes(b''.join(struct.pack('<h',round(math.sin(i*2*math.pi*440/44100)*4000)) for i in range(4410)))
wav_bytes=original.read_bytes()
proc=ws=log=None
serial=0
target=None
window_id=None

def saved():
    try:return json.loads(settings_file.read_text(encoding='utf8'))
    except (ValueError,OSError):return {}

def wait_saved(test,label,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if test(saved()):return
        if proc and proc.poll() is not None:raise RuntimeError(f'launcher exited: {proc.returncode}')
        time.sleep(.1)
    raise AssertionError('settings did not persist: '+label)

def launch():
    global proc,ws,log,target,serial,window_id
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env={**os.environ,'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_CACHE_HOME':str(home/'.cache'),
         'XDG_DATA_HOME':str(home/'.local/share'),'XDG_RUNTIME_DIR':str(runtime),'OMNISPEC_HOME':str(data),
         'WEBKIT_INSPECTOR_HTTP_SERVER':f'127.0.0.1:{port}','WEBKIT_DISABLE_COMPOSITING_MODE':'1','WEBKIT_DISABLE_DMABUF_RENDERER':'1',
         # Suppress live update/catalog traffic while allowing the local inspector.
         'HTTP_PROXY':'http://127.0.0.1:9','HTTPS_PROXY':'http://127.0.0.1:9','ALL_PROXY':'http://127.0.0.1:9',
         'http_proxy':'http://127.0.0.1:9','https_proxy':'http://127.0.0.1:9','all_proxy':'http://127.0.0.1:9',
         'NO_PROXY':'localhost,127.0.0.1,::1','no_proxy':'localhost,127.0.0.1,::1'}
    log=(root/'launcher.log').open('a')
    proc=subprocess.Popen([str(binary)],stdout=log,stderr=log,env=env)
    deadline=time.monotonic()+90; match=None
    while time.monotonic()<deadline:
        if proc.poll() is not None:raise RuntimeError(f'launcher exited: {proc.returncode}')
        try:
            html=urllib.request.urlopen(f'http://127.0.0.1:{port}/',timeout=1).read().decode()
            match=re.search(r"(/socket/[^']+)",html)
            if match and 'tauri://localhost' in html:break
        except Exception:pass
        time.sleep(.2)
    if not match:raise RuntimeError('WebKit inspector unavailable; use debug build')
    ws=websocket.create_connection(f'ws://127.0.0.1:{port}'+match.group(1),timeout=20,origin=f'http://127.0.0.1:{port}')
    ws.send(json.dumps({'id':1,'method':'Target.setPauseOnStart','params':{'pauseOnStart':False}}));target=None;serial=1
    for _ in range(50):
        msg=json.loads(ws.recv())
        if msg.get('method')=='Target.targetCreated':target=msg['params']['targetInfo']['targetId'];break
    assert target,'no WebKit target'
    wait('window.omnispecDebug && window.omnispecDebug.state.settings',90)
    ids=subprocess.check_output(['xdotool','search','--name','^OmniSpec$'],text=True).strip().splitlines()
    assert len(ids)==1,ids
    window_id=ids[0]
    subprocess.run(['xdotool','windowmove',window_id,'0','0'],check=True)
    subprocess.run(['xdotool','windowsize',window_id,'1080','640'],check=True)
    time.sleep(.3)

def stop():
    global proc,ws,log
    if ws:
        try:ws.close()
        except Exception:pass
        ws=None
    if proc:
        proc.terminate()
        try:proc.wait(timeout=8)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
        proc=None
    if log:log.close();log=None
    time.sleep(.4)

def evaluate(expression):
    global serial
    serial+=1; sid=serial
    inner={'id':sid,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True}}
    ws.send(json.dumps({'id':100000+sid,'method':'Target.sendMessageToTarget','params':{'targetId':target,'message':json.dumps(inner)}}))
    while True:
        message=json.loads(ws.recv())
        if message.get('id')==100000+sid and 'error' in message:raise RuntimeError(message['error'])
        if message.get('method')!='Target.dispatchMessageFromTarget':continue
        response=json.loads(message['params']['message'])
        if response.get('id')!=sid:continue
        if 'error' in response or response.get('result',{}).get('wasThrown'):raise RuntimeError(response)
        return response['result']['result'].get('value')

def get(expression):return json.loads(evaluate('JSON.stringify('+expression+')'))
def wait(expression,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if proc.poll() is not None:raise RuntimeError(f'launcher exited: {proc.returncode}')
        if get('Boolean('+expression+')'):return
        time.sleep(.15)
    detail=get("({toasts:document.querySelector('#toasts')?.innerText,modal:document.querySelector('#modal-prefs')?.hidden,body:document.querySelector('#prefs-body')?.innerText?.slice(0,700)})")
    raise TimeoutError(f'{expression}; UI={detail}')

def click(selector):
    wait('document.querySelector('+json.dumps(selector)+') && !document.querySelector('+json.dumps(selector)+').disabled')
    evaluate('document.querySelector('+json.dumps(selector)+').click(); true')

def trusted_click(selector):
    # WebKit may require a real user gesture to resume the audio context.
    wait('document.querySelector('+json.dumps(selector)+') && !document.querySelector('+json.dumps(selector)+').disabled')
    evaluate('document.querySelector('+json.dumps(selector)+').scrollIntoView({block:"center"}); true')
    time.sleep(.3)
    rect=get('(()=>{const r=document.querySelector('+json.dumps(selector)+').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()')
    assert rect['w']>0 and rect['h']>0,rect
    subprocess.run(['xdotool','mousemove','--window',window_id,str(round(rect['x'])),str(round(rect['y'])),'click','1'],check=True)

def value(selector,new,event='change'):
    evaluate('(()=>{const e=document.querySelector(%s);e.value=%s;e.dispatchEvent(new Event(%s,{bubbles:true}));return true})()' % (json.dumps(selector),json.dumps(new),json.dumps(event)))

def open_prefs(category):
    if get("document.querySelector('#modal-prefs').hidden"):click('#btn-quick-settings')
    click('[data-pref="'+category+'"]')

def audio_watch():
    evaluate("""(()=>{window.__realSoundPlays=[];if(window.__soundWatchInstalled)return true;
      window.__soundWatchInstalled=true;const C=window.AudioContext||window.webkitAudioContext;const old=C.prototype.createBufferSource;
      C.prototype.createBufferSource=function(){const audio=this,src=old.call(this),connect=src.connect.bind(src),start=src.start.bind(src);
        src.connect=function(node,...rest){src.__gain=node;return connect(node,...rest)};
        src.start=function(...args){window.__realSoundPlays.push({duration:src.buffer?.duration,gain:src.__gain?.gain?.value,state:audio.state});return start(...args)};return src};return true})()""")

def invoke_async(command,args):
    evaluate('window.__invokeResult=null;window.__invokeError=null;window.__TAURI__.core.invoke(%s,%s).then(x=>window.__invokeResult=x).catch(e=>window.__invokeError=String(e));true' % (json.dumps(command),json.dumps(args)))
    wait('window.__invokeResult !== null || window.__invokeError !== null')
    error=get('window.__invokeError')
    if error:raise RuntimeError(error)
    return get('window.__invokeResult')

try:
    assert not settings_file.exists()
    launch();wait("!document.querySelector('#modal-onboard').hidden",90)
    wait_saved(lambda s:s.get('onboarding_pending') is True and s.get('onboarded') is False,'new profile marker')
    assert get("document.querySelectorAll('[data-onboard-language]').length")==5
    click('[data-onboard-language="en"]');wait_saved(lambda s:s.get('language')=='en','English')
    wait("document.documentElement.lang==='en' && !document.querySelector('#onboard-next').disabled")
    stop()
    # Keep the real fresh profile and unfinished wizard but turn off unrelated
    # network/visual services before resuming the rest of this isolated test.
    first = saved()
    first.update({'update_enabled':False,'discord_rpc':False,'click_fx':'off','ambient':'off','trail':False})
    settings_file.write_text(json.dumps(first),encoding='utf8')
    launch();wait("!document.querySelector('#modal-onboard').hidden",90)
    assert get("document.documentElement.lang")=="en"
    click('[data-onboard-language="ru"]');wait_saved(lambda s:s.get('language')=='ru','Russian')
    wait("!document.querySelector('#onboard-next').disabled")
    for _ in range(6):click('#onboard-next')
    wait_saved(lambda s:s.get('onboarded') is True,'onboarding')
    wait("document.querySelector('#dv-results')")
    assert get("document.querySelector('#home-filters-toggle').getAttribute('aria-expanded')")=='false'
    wide=get("document.querySelector('#dv-results').getBoundingClientRect().width")
    click('#home-filters-toggle');time.sleep(.3)
    narrow=get("document.querySelector('#dv-results').getBoundingClientRect().width")
    assert wide>narrow+70,(wide,narrow)
    evaluate("document.querySelector('#dv-results').style.minHeight='2000px';document.querySelector('#home-scroll').scrollTop=99999;true")
    pinned=get("Math.abs(document.querySelector('.home-feed-head').getBoundingClientRect().top-document.querySelector('#home-scroll').getBoundingClientRect().top)")
    assert pinned<8,pinned
    print('LINUX_WEBKIT_V0500_ONBOARD_AND_STICKY_CATALOG_OK',flush=True)

    audio_watch();open_prefs('sound')
    assert get("document.querySelector('#set-sound-volume').max")=='200'
    value('#set-sound-volume','200','input');value('#set-sound-volume','200','change')
    wait_saved(lambda s:s.get('sound_volume')==200,'200% master')
    click('[data-sound-style="custom"]');wait("document.querySelector('[data-sound-path=click]')")
    value('[data-sound-path="click"]',str(original),'change')
    wait_saved(lambda s:bool(s.get('sound_custom',{}).get('click',{}).get('file')),'custom WAV import')
    wait("document.querySelector('[data-sound-preview=click]:not([disabled])')")
    copy=data/'sounds'/saved()['sound_custom']['click']['file']
    assert copy.read_bytes()==wav_bytes
    value('[data-sound-volume="click"]','150','input');value('[data-sound-volume="click"]','150','change')
    wait_saved(lambda s:s['sound_custom']['click']['volume']==150,'150% individual')
    evaluate('window.__realSoundPlays=[];true')
    trusted_click('[data-sound-preview="click"]')
    wait("window.__realSoundPlays.some(p=>p.duration>0 && Math.abs(p.gain-3)<.01)",20)
    print('LINUX_WEBKIT_REAL_WAV_DECODE_AND_GAIN_OK',get('window.__realSoundPlays'),flush=True)
    original.unlink();stop();launch()
    assert get("document.querySelector('#modal-onboard').hidden")
    assert get('window.omnispecDebug.state.sound.volume')==200
    audio_watch();open_prefs('sound');wait("document.querySelector('[data-sound-preview=click]:not([disabled])')")
    assert get("document.querySelector('[data-sound-volume=click]').value")=='150'
    evaluate('window.__realSoundPlays=[];true');trusted_click('[data-sound-preview="click"]')
    wait("window.__realSoundPlays.some(p=>p.duration>0 && Math.abs(p.gain-3)<.01)",20)
    print('LINUX_WEBKIT_WAV_COPY_SURVIVES_SOURCE_REMOVAL_AND_RESTART_OK',flush=True)

    first=invoke_async('set_custom_wallpaper',{'path':str(repo/'tools/tests/fixtures/profile/one.png')})
    second=invoke_async('set_custom_wallpaper',{'path':str(repo/'tools/tests/fixtures/profile/two.png')})
    a,b=first['custom_wallpaper'],second['custom_wallpaper']
    assert a!=b and 'custom:'+a in second['wallpaper_recent'] and 'custom:'+b in second['wallpaper_recent']
    stop();launch();open_prefs('wall')
    sel='[data-wall-history-select='+json.dumps('custom:'+a)+']'
    wait('document.querySelector('+json.dumps(sel)+')')
    wait("getComputedStyle(document.querySelector(%s)).backgroundImage!=='none'" % json.dumps(sel),20)
    click(sel);wait_saved(lambda s:s.get('custom_wallpaper')==a and s.get('wallpaper')=='custom','historical custom background')
    remove='[data-wall-history-remove='+json.dumps('custom:'+a)+']'
    click(remove);wait_saved(lambda s:'custom:'+a not in s.get('wallpaper_recent',[]),'remove history entry')
    assert saved()['custom_wallpaper']==a and saved()['wallpaper']=='custom' and (data/'wallpapers'/a).is_file()
    stop();launch();open_prefs('wall')
    assert not get('Boolean(document.querySelector('+json.dumps(sel)+'))')
    assert get('Boolean(document.querySelector('+json.dumps('[data-wall-history-select='+json.dumps('custom:'+b)+']')+'))')
    assert saved()['custom_wallpaper']==a
    print('LINUX_WEBKIT_REAL_WALLPAPER_HISTORY_AND_RESTART_OK',flush=True)
    stop()
    # Even an old installation with no instances/accounts must not be mistaken
    # for a fresh profile merely because it predates onboarding_pending.
    settings_file.write_text(json.dumps({'onboarded':False,'update_enabled':False,'discord_rpc':False,
        'username':'Existing','language':'ru'}),encoding='utf8')
    launch();wait("window.omnispecDebug.state.settings.onboarded === true",90)
    assert get("document.querySelector('#modal-onboard').hidden") and saved().get('username')=='Existing'
    print('LINUX_WEBKIT_EMPTY_LEGACY_PROFILE_SKIPS_WIZARD_AND_PRESERVES_SETTINGS_OK',flush=True)
except Exception:
    traceback.print_exc()
    if log:log.flush()
    try:print('APP_LOG_TAIL', (root/'launcher.log').read_text(errors='replace')[-6000:],flush=True)
    except Exception:pass
    raise
finally:
    stop();shutil.rmtree(root,ignore_errors=True)
