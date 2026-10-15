================================================================================
          ONE-TRIP ERRAND PLANNER & EVERYDAY NEEDS FINDER — README
================================================================================

1. PROJECT OVERVIEW
-------------------
One-Trip Errand Planner is an improved OpenStreetMap web application that helps
users discover essential everyday amenities (hospitals, pharmacies, ATMs,
public toilets, drinking water, and EV charging points) and assemble them into a
single, optimized multi-stop errand trip.

The application opens directly into a full-viewport interactive Leaflet map
with floating translucent glassmorphism panels along the left and right edges:
  • Left Panel (Explore): Search location, facility category filters, radius,
    sort controls, and live nearby place cards with "+ Add to Trip" actions.
  • Right Panel (My Trip): Ordered list of errand destinations with numbered
    badges, reorder controls (move up/down), stop removal, total route distance,
    estimated driving time, and single-click route planning via OSRM.

Developed as a CIA assignment for Full Stack Development (FSD), MSc AIML.


2. ARCHITECTURE & KEY FEATURES
------------------------------
A. Full-Screen Interactive Map
   • Occupies 100% of the viewport (width & height).
   • OpenStreetMap tiles with Leaflet 1.9.4.
   • Smooth pan and zoom with automatic bounds fitting.

B. Floating Glassmorphism Panels
   • Sleek translucent panels with CSS backdrop-filter: blur(16px), subtle
     borders, soft depth shadows, and dark navy/slate palette.
   • Non-intrusive floating layout keeps the interactive map visible underneath.
   • Independently scrollable results and trip lists with custom scrollbars.
   • Responsive design: desktop shows dual edge panels; mobile screens (<1024px)
     provide a quick navigation bar (Explore / Trip / Map View).

C. Nearby Facility Discovery (Overpass API)
   • 6 amenity categories: Hospitals, Pharmacies, ATMs, Public Toilets,
     Drinking Water, and EV Charging Stations.
   • Simplified regex query for fast batch responses:
     nwr["amenity"~"^(hospital|pharmacy|atm|toilets|drinking_water|charging_station)$"]
   • Multi-server failover mechanism (overpass-api.de + kumi.systems) with
     per-server timeouts, AbortController, and graceful error alerts.
   • Dynamic radius (500m, 1km, 2km, 5km) and sorting (nearest first vs A-Z).

D. One-Trip Errand Planner (New Main Feature)
   • Add places from search results or details card into an ordered trip.
   • Visual numbered markers on the map (1, 2, 3...) matching the trip sequence.
   • Reorder stops up or down with automatic sequence and marker recalculation.
   • Prevent accidental duplicate destination additions with visual feedback.
   • Real OSRM driving route engine: draws an exact road polyline on the map.
   • Real route metrics: displays exact road distance (m / km) and driving time.
   • LocalStorage persistence: retains planned stops across browser refreshes.
   • Clear / Reset action: removes route, markers, and resets state.


3. PROJECT STRUCTURE
--------------------
CIA-1Project/
│
├── index.html      HTML5 document with full-viewport layout & floating panels
├── styles.css      Leaflet core CSS + modern glassmorphism UI & custom pins
├── app.js          Complete logic (Overpass failover, Nominatim, OSRM routing)
└── README.txt      Project documentation, tech stack, APIs, and setup guide


4. TECH STACK & APIS
--------------------
• Markup & Style: HTML5, CSS3 (Glassmorphism, Flexbox, CSS Grid), Tailwind CDN
• Logic & State: Vanilla JavaScript (ES2022, async/await, AbortController)
• Mapping: Leaflet 1.9.4 & OpenStreetMap tile layer
• Geocoding: Nominatim API (https://nominatim.openstreetmap.org)
• Facility Search: Overpass API with failover endpoints
• Driving Routing: Project-OSRM (https://router.project-osrm.org/route/v1/driving)
  Fallback Routing: routing.openstreetmap.de (routed-car & routed-foot)


5. SETUP & LOCAL EXECUTION
--------------------------
No compilation, build tools, or Node.js runtime required.

  1. Clone or extract the project folder.
  2. Start any local web server (or run: npx http-server -p 8080).
  3. Open http://localhost:8080/index.html in modern Chrome, Edge, or Firefox.
  4. Requires an active internet connection for live OSM tiles and API queries.


6. JAVASCRIPT EVENT WORKFLOW
----------------------------
  1. Form Submit ('submit' on #searchForm)
     Validates query length and geocodes location via Nominatim.
  2. Quick Example Click ('click' on .ex)
     Pre-fills and submits location ("Connaught Place, Delhi" or "MG Road, Bengaluru").
  3. Geolocation Click ('click' on #locBtn)
     Acquires GPS coordinates via navigator.geolocation.getCurrentPosition.
  4. Map Click ('click' on map)
     Sets clicked point as search origin and triggers nearby facility search.
  5. Category Checkbox Change ('change' on #cats)
     Toggles categories and triggers debounced Overpass search.
  6. Radius Change ('change' on #radius)
     Adjusts map zoom level and refreshes amenity query.
  7. Sort Change ('change' on #sort)
     Re-sorts cards by nearest-first or alphabetical without re-fetching API.
  8. Add to Trip ('click' delegated on [data-action="add-trip"])
     Adds destination to tripStops, saves to localStorage, adds numbered map pin.
  9. Move Stop Up/Down ('click' delegated on .move-up-btn / .move-down-btn)
     Swaps stop sequence in tripStops array and refreshes map pins.
 10. Remove Stop ('click' delegated on .remove-stop-btn)
     Removes stop, updates numbering, and invalidates outdated route.
 11. Plan My Trip ('click' on #planTripBtn)
     Gathers sequence coordinates, requests OSRM road route, draws polyline,
     and computes total driving distance and time.
 12. Reset Trip ('click' on #clearTripBtn)
     Clears trip stops, map route, markers, and localStorage.


7. KNOWN LIMITATIONS & GRACEFUL HANDLING
----------------------------------------
• Public API Rate Limits: Overpass & OSRM are shared community resources.
  The app includes per-server failover, request aborts, and helpful error alerts.
• Road Routing: OSRM calculates drivable road routes. Walking routes are also
  supported individually inside the place detail card.
• Map coverage depends on OpenStreetMap volunteer contributions in each area.


8. AI USAGE DECLARATION
-----------------------
Developed with pair-programming assistance from Google Antigravity AI for
architectural structuring, glassmorphism UI design, and API integration. All
code has been reviewed and tested for academic evaluation.

================================================================================
