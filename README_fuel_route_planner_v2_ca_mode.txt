Fuel Route Planner V2 + Before Entering CA Mode

Files:
- fuel_route_planner_app_v2_ca_mode.html
- start_server.py
- start_windows.bat

Run locally:
1. Extract the ZIP.
2. Open a terminal in that folder.
3. Run:
   python start_server.py
   or:
   py start_server.py
4. Open:
   http://127.0.0.1:8000/fuel_route_planner_app_v2_ca_mode.html

New mode:
- Before Entering CA Mode
  - Intended for California-bound trips.
  - Uses a fixed arrival-fuel window of 35 to 55 gallons.
  - Suggests exactly one Arizona route-side stop before entering California.
  - Keeps the rest of the V2 logic the same.
