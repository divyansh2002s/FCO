import http.server
import socketserver
import webbrowser
from pathlib import Path

PORT = 8000
ROOT = Path(__file__).resolve().parent

def choose_html_file():
    preferred = [
        "fuel_route_planner_app_v2_ca_mode_samsara_pre_ca_cheapest_autocomplete.html",
        "fuel_route_planner_app_v2_ca_mode_samsara.html",
        "fuel_route_planner_app_v2_ca_mode_samsara_pre_ca_cheapest.html",
        "fuel_route_planner_app_v2_ca_mode.html",
        "fuel_route_planner_app_v2.html",
    ]
    for name in preferred:
        path = ROOT / name
        if path.exists():
            return path.name

    matches = sorted(ROOT.glob("fuel_route_planner*.html"), key=lambda p: p.stat().st_mtime, reverse=True)
    if matches:
        return matches[0].name

    html_matches = sorted(ROOT.glob("*.html"), key=lambda p: p.stat().st_mtime, reverse=True)
    if html_matches:
        return html_matches[0].name

    return None

TARGET_HTML = choose_html_file()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

if TARGET_HTML is None:
    print(f"No HTML file found in {ROOT}")
else:
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/{TARGET_HTML}"
        print(f"Serving {ROOT} at {url}")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        httpd.serve_forever()
