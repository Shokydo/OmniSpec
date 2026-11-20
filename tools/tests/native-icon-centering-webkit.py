#!/usr/bin/env python3
"""Проверка CSS/SVG в WebKitGTK (движок Linux-версии Tauri).

Запуск в изолированном X-сервере:
  xvfb-run -a dbus-run-session -- /usr/bin/python3 tools/tests/native-icon-centering-webkit.py
Нужны GTK 3, WebKit2 4.1 и соответствующие GObject-introspection пакеты.
Это проверка движка на небольших реальных CSS-компонентах, не запуск Tauri.
"""
import json
import os
from pathlib import Path
import sys

os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2

ui = Path(__file__).resolve().parents[2] / "apps/omnispec-app/ui"
index = (ui / "index.html").read_text(encoding="utf-8")
style = (ui / "styles.css").read_text(encoding="utf-8")
start = index.index('<svg style="display:none"')
end = index.index('</svg>', start) + len('</svg>')
symbols = index[start:end]
icon = '<svg class="ic"><use href="#i-star"/></svg>'
html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>{style}
#fixture {{ display:flex; flex-direction:column; gap:6px; padding:8px }}
.row {{ display:flex; align-items:center; gap:8px }}
</style></head><body>{symbols}<div id="fixture">
<div class="row">
  <button data-probe="button-26" class="icon-btn">{icon}</button>
  <div class="skin-col-head"><button data-probe="button-22" class="icon-btn">{icon}</button></div>
  <div class="build-path"><button data-probe="button-20" class="icon-btn">{icon}</button></div>
  <button data-probe="picker" class="icon-chip" style="width:34px">{icon}</button>
  <button data-probe="source" class="catalog-source">{icon}</button>
  <button data-probe="filter" class="home-filters-toggle">{icon}</button>
</div><div class="row">
  <div data-probe="list-letter" class="card-icon"><span class="card-letter">M</span></div>
  <div data-probe="project-letter" class="proj-icon"><span class="card-letter">M</span></div>
  <div data-probe="instance" class="instance-icon">{icon}</div>
  <div data-probe="home" class="home-card-icon">{icon}</div>
  <div data-probe="mod" class="mod-icon">{icon}</div>
  <div data-probe="external" class="ext-icon">{icon}</div>
  <div data-probe="avatar" class="acc-avatar">{icon}</div>
  <div data-probe="error" class="errors-status-icon">{icon}</div>
  <div class="fm-row"><span data-probe="tree" class="ico">{icon}</span></div>
</div><div class="row">
  <div data-probe="tile" class="build-tile-shot"><span class="build-tile-icon is-symbol">{icon}</span></div>
  <span data-probe="cape" class="cape-thumb cape-thumb-off">{icon}</span>
  <span data-probe="shot" class="shot-img" style="width:180px">{icon.replace('class="ic"', 'class="ic shot-placeholder"')}</span>
</div></div></body></html>"""

javascript = r"""
(() => {
  const checked = [], errors = [];
  for (const zoom of [0.7, 1, 1.5]) {
    document.body.style.zoom=zoom;
    document.documentElement.style.setProperty('--ui-zoom',String(zoom));
    for (const parent of document.querySelectorAll('[data-probe]')) {
      const child=parent.firstElementChild;
      const a=parent.getBoundingClientRect(), b=child.getBoundingClientRect();
      const dx=(b.left+b.right-a.left-a.right)/2, dy=(b.top+b.bottom-a.top-a.bottom)/2;
      if (!a.width || !a.height || !b.width || !b.height || Math.abs(dx)>0.7 || Math.abs(dy)>0.7)
        errors.push({name:parent.dataset.probe,zoom,dx,dy,parent:[a.width,a.height],child:[b.width,b.height]});
      if ((parent.dataset.probe==='list-letter' || parent.dataset.probe==='project-letter') &&
          (b.left<a.left-0.2 || b.right>a.right+0.2 || b.top<a.top-0.2 || b.bottom>a.bottom+0.2))
        errors.push({name:parent.dataset.probe,zoom,problem:'clipped letter'});
      checked.push(parent.dataset.probe+'@'+zoom);
    }
  }
  const ns='http://www.w3.org/2000/svg';
  for (const id of ['i-heart','i-bolt','i-refresh','i-chev']) {
    const svg=document.createElementNS(ns,'svg'), use=document.createElementNS(ns,'use');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');
    use.setAttribute('href','#'+id);svg.append(use);document.querySelector('#fixture').append(svg);
    const b=use.getBBox(), dx=b.x+b.width/2-12, dy=b.y+b.height/2-12;
    if (Math.abs(dx)>0.1 || (id!=='i-heart' && Math.abs(dy)>0.1)) errors.push({name:id,dx,dy});
    svg.remove();
  }
  return JSON.stringify({checked,errors,engine:navigator.userAgent});
})()
"""

status = 1
window = Gtk.Window()
window.set_default_size(1600, 900)
view = WebKit2.WebView()
window.add(view)
window.show_all()


def finished(webview, result, _):
    global status
    try:
        value = webview.evaluate_javascript_finish(result)
        data = json.loads(value.to_string())
        if data["errors"]:
            raise AssertionError(json.dumps(data["errors"], ensure_ascii=False))
        assert len(data["checked"]) == 18 * 3, data["checked"]
        print("NATIVE_WEBKITGTK_ICON_CENTERING_OK", len(data["checked"]),
              "measurements, zoom 70/100/150%, four SVG contours", flush=True)
        print("ENGINE", data["engine"], flush=True)
        status = 0
    except Exception as error:
        print("NATIVE_WEBKITGTK_ICON_CENTERING_FAILED", repr(error), file=sys.stderr, flush=True)
    Gtk.main_quit()


def on_load(webview, event):
    if event == WebKit2.LoadEvent.FINISHED:
        webview.evaluate_javascript(javascript, -1, None, None, None, finished, None)


def timeout():
    print("NATIVE_WEBKITGTK_ICON_CENTERING_TIMEOUT", file=sys.stderr, flush=True)
    Gtk.main_quit()
    return False


view.connect("load-changed", on_load)
GLib.timeout_add_seconds(45, timeout)
view.load_html(html, ui.as_uri() + "/")
Gtk.main()
window.destroy()
sys.exit(status)
