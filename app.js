/* ==========================================================
   app.js — One-Trip Errand Planner & Everyday Needs Finder
   Vanilla JS implementation with Leaflet, Overpass API,
   Nominatim Geocoding, and OSRM Driving Route Engine.
   ========================================================== */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ── Guard: ensure Leaflet loaded ───────────────────────── */
if (typeof L === 'undefined') {
    const mapEl = $('#map');
    if (mapEl) {
        mapEl.innerHTML = '<p class="mapmsg">The map library did not load. Check your internet connection or ad-blocker.</p>';
    }
    throw new Error('Leaflet library not loaded');
}

/* ── Constants ──────────────────────────────────────────── */
const CATS = {
    hospital: { label: 'Hospitals', one: 'Hospital', color: '#ef4444', sym: 'H' },
    pharmacy: { label: 'Pharmacies', one: 'Pharmacy', color: '#10b981', sym: 'Rx' },
    atm: { label: 'ATMs', one: 'ATM', color: '#3b82f6', sym: '₹' },
    toilets: { label: 'Public Toilets', one: 'Public Toilet', color: '#a855f7', sym: 'WC' },
    drinking_water: { label: 'Drinking Water', one: 'Drinking Water', color: '#06b6d4', sym: '💧' },
    charging_station: { label: 'EV Charging', one: 'EV Charging', color: '#f59e0b', sym: '⚡' }
};

const ZOOM = { 500: 16, 1000: 15, 2000: 14, 5000: 13 };

/* ── Overpass API Failover ──────────────────────────────── */
async function fetchOverpass(query, parentSignal) {
    const servers = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter"
    ];

    let lastError = null;

    for (const server of servers) {
        if (parentSignal.aborted) {
            throw new DOMException("Search cancelled", "AbortError");
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const cancel = () => controller.abort();
        parentSignal.addEventListener("abort", cancel, { once: true });

        try {
            const response = await fetch(server, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({ data: query }),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

            const data = await response.json();

            if (!Array.isArray(data.elements)) {
                throw new Error("Unexpected response from nearby search service.");
            }

            return data;

        } catch (error) {
            if (parentSignal.aborted) {
                throw new DOMException("Search cancelled", "AbortError");
            }

            lastError = error;
            console.warn("Overpass endpoint failed:", server, error.message);

        } finally {
            clearTimeout(timeout);
            parentSignal.removeEventListener("abort", cancel);
        }
    }

    throw new Error(
        "Nearby search servers are busy or unreachable. " +
        "Check your internet connection and retry. " +
        (lastError?.message || "")
    );
}

/* ── Map Initialisation ─────────────────────────────────── */
const map = L.map('map', {
    zoomControl: false // Move zoom control to avoid covering panels
}).setView([20.5937, 78.9629], 5);

// Add zoom control to top-center / bottom-right
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).on('tileerror', () => {
    if (!$('.mapmsg')) {
        map.getContainer().insertAdjacentHTML('beforeend', '<div class="mapmsg">Map tiles are slow to load. Check your internet connection.</div>');
    }
}).addTo(map);

// Separate layer groups for clean management
const nearbyLayer = L.layerGroup().addTo(map);
const tripMarkersLayer = L.layerGroup().addTo(map);
let tripRouteLayer = null;
let singleRouteLayer = null;

/* ── State ──────────────────────────────────────────────── */
let origin = null;
let originMk = null;
let places = [];
let ctrl = null;
let timer = null;

// Trip planner state
let tripStops = [];
const STORAGE_KEY = 'errand_planner_trip_stops_v1';

/* ── Utilities ──────────────────────────────────────────── */
const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = m => {
    if (m == null || isNaN(m)) return '—';
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
};

const fmtTime = sec => {
    if (!sec || isNaN(sec)) return '—';
    const min = Math.round(sec / 60);
    if (min < 60) return min + ' min';
    const hrs = Math.floor(min / 60);
    const rem = min % 60;
    return `${hrs}h ${rem}m`;
};

function hav(a, b, c, d) {
    const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
    const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function status(kind, msg) {
    const s = $('#status');
    if (!s) return;
    const cls = {
        load: 'bg-slate-800/90 text-zinc-300 border border-slate-700',
        error: 'bg-rose-950/80 text-rose-200 border border-rose-800/80',
        info: 'bg-slate-800/90 text-cyan-200 border border-cyan-800/60'
    }[kind] || 'bg-slate-800/80 text-zinc-300';

    s.className = 'rounded-lg p-2.5 text-xs transition ' + cls + (msg ? '' : ' hidden');
    s.innerHTML = (kind === 'load' ? '<span class="inline-block w-3.5 h-3.5 mr-2 align-middle border-2 border-zinc-500 border-t-emerald-400 rounded-full animate-spin"></span>' : '') + esc(msg || '');
}

const netMsg = e => e instanceof TypeError ? 'Network problem. Check your connection and try again.' : (e.message || 'Something went wrong. Try again.');

/* ── Build Category Chips ───────────────────────────────── */
function initCategories() {
    const catsEl = $('#cats');
    if (!catsEl) return;
    catsEl.innerHTML = '';

    Object.entries(CATS).forEach(([k, c]) => {
        const l = document.createElement('label');
        l.className = `cat-pill ${k === 'hospital' || k === 'pharmacy' ? 'active' : ''}`;
        l.innerHTML = `
            <input type="checkbox" class="cat sr-only" value="${k}" ${k === 'hospital' || k === 'pharmacy' ? 'checked' : ''}>
            <i class="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${c.color}"></i>
            <span class="truncate">${c.label}</span>
        `;

        l.querySelector('input').addEventListener('change', e => {
            l.classList.toggle('active', e.target.checked);
        });

        catsEl.appendChild(l);
    });
}

/* ── Choose Search Centre ───────────────────────────────── */
function setOrigin(lat, lon, label) {
    origin = { lat, lon };

    if (originMk) {
        originMk.setLatLng([lat, lon]);
    } else {
        originMk = L.marker([lat, lon], {
            icon: L.divIcon({
                className: '',
                html: '<div class="origin-pin"></div>',
                iconSize: [22, 22],
                iconAnchor: [11, 11]
            }),
            zIndexOffset: 1000
        }).addTo(map).bindTooltip('Search Origin', { permanent: false, direction: 'top' });
    }

    map.setView([lat, lon], ZOOM[$('#radius').value] || 15);
    $('#where').textContent = 'Around: ' + (label ? label.split(',').slice(0, 3).join(',') : `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
    load();
}

/* ── Fetch Nearby Places from Overpass ──────────────────── */
async function load() {
    if (!origin) {
        return status('info', 'Pick a location first: search a place, use GPS, or click on the map.');
    }

    const cats = [...document.querySelectorAll('.cat:checked')].map(i => i.value);
    if (!cats.length) {
        places = [];
        renderResults();
        return status('error', 'Select at least one facility category above.');
    }

    const r = +$('#radius').value;
    const amenityList = cats.join("|");

    const q = `
[out:json][timeout:15];
nwr["amenity"~"^(${amenityList})$"]
(around:${r},${origin.lat},${origin.lon});
out center tags;
`;

    if (ctrl) ctrl.abort();
    const mine = ctrl = new AbortController();
    const t = setTimeout(() => mine.abort(), 20000);

    status('load', 'Searching nearby facilities…');
    $('#results').setAttribute('aria-busy', 'true');

    try {
        const data = await fetchOverpass(q, mine.signal);

        places = (data.elements || []).map(e => {
            const t = e.tags || {}, lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
            return {
                id: e.type + e.id,
                type: e.type,
                oid: e.id,
                lat,
                lon,
                cat: t.amenity,
                tags: t,
                name: t.name || CATS[t.amenity]?.one || 'Facility',
                dist: hav(origin.lat, origin.lon, lat, lon)
            };
        }).filter(p => p.lat != null && CATS[p.cat]);

        renderResults();
        status('');

    } catch (e) {
        if (e.name === 'AbortError') {
            if (mine !== ctrl) return;
            status('error', 'The search request timed out. Try choosing a smaller radius.');
        } else {
            status('error', netMsg(e));
        }
    } finally {
        clearTimeout(t);
        if (mine === ctrl) $('#results').setAttribute('aria-busy', 'false');
    }
}

/* ── Show Search Cards & Map Markers ────────────────────── */
function renderResults() {
    nearbyLayer.clearLayers();
    clearSingleRoute();
    $('#detail').classList.add('hidden');

    const sortType = $('#sort').value;
    const list = [...places].sort(sortType === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.dist - b.dist);
    const box = $('#results');

    $('#count').textContent = list.length ? `(${list.length})` : '';
    box.innerHTML = '';

    if (!list.length) {
        box.innerHTML = `
            <div class="rounded-xl border border-dashed border-slate-700/80 p-4 text-center text-zinc-400 text-xs">
                No matching facilities found within ${fmt(+$('#radius').value)}.
                Try increasing the radius or toggling other categories.
            </div>`;
        return;
    }

    list.forEach(p => {
        const c = CATS[p.cat];
        const isAdded = tripStops.some(s => s.id === p.id);

        // Map marker
        L.marker([p.lat, p.lon], {
            icon: L.divIcon({
                className: '',
                html: `<div class="pin" style="background:${c.color}"><span>${c.sym}</span></div>`,
                iconSize: [30, 30],
                iconAnchor: [15, 30]
            })
        }).addTo(nearbyLayer).bindTooltip(esc(p.name)).on('click', () => selectPlace(p.id));

        // Result card
        const card = document.createElement('div');
        card.className = `place-card ${isAdded ? 'border-blue-500/50 bg-blue-950/20' : ''}`;
        card.dataset.id = p.id;

        const street = [p.tags['addr:street'], p.tags['addr:suburb'], p.tags['addr:city']].filter(Boolean).join(', ');

        card.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5 mb-1">
                        <span class="inline-block w-2 h-2 rounded-full flex-shrink-0" style="background:${c.color}"></span>
                        <span class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide truncate">${c.one}</span>
                    </div>
                    <h3 class="font-semibold text-white text-xs truncate leading-snug">${esc(p.name)}</h3>
                    <p class="text-[11px] text-zinc-400 mt-0.5">${fmt(p.dist)} away ${street ? '· ' + esc(street) : ''}</p>
                </div>
                <button type="button" data-action="add-trip" data-id="${p.id}"
                    class="flex-shrink-0 px-2 py-1 rounded-md text-[11px] font-medium transition ${isAdded
                        ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40 cursor-default'
                        : 'bg-emerald-600/80 hover:bg-emerald-500 text-white shadow-sm'}">
                    ${isAdded ? '✓ Added' : '+ Add'}
                </button>
            </div>
        `;

        box.appendChild(card);
    });
}

/* ── Place Details View ─────────────────────────────────── */
function selectPlace(id) {
    const p = places.find(x => x.id === id) || tripStops.find(x => x.id === id);
    if (!p) return;

    map.panTo([p.lat, p.lon]);

    // Highlight card
    $$('.place-card').forEach(c => c.classList.toggle('selected', c.dataset.id === id));

    const t = p.tags || {};
    const rows = [
        ['Address', ['addr:housenumber', 'addr:street', 'addr:suburb', 'addr:city'].map(k => t[k]).filter(Boolean).join(', ')],
        ['Opening Hours', t.opening_hours],
        ['Phone', t.phone || t['contact:phone']],
        ['Operator', t.operator],
        ['Fee', t.fee],
        ['Wheelchair', t.wheelchair],
        ['Emergency', t.emergency],
        ['Sockets / Ports', t.capacity]
    ].filter(r => r[1]);

    const isAdded = tripStops.some(s => s.id === p.id);
    const d = $('#detail');
    d.classList.remove('hidden');

    d.innerHTML = `
        <div class="flex items-start justify-between gap-2 border-b border-slate-700/60 pb-2">
            <div>
                <h3 class="font-bold text-white text-sm leading-tight">${esc(p.name)}</h3>
                <p class="text-[11px] text-zinc-400">${CATS[p.cat]?.one || 'Place'} · ${origin ? fmt(p.dist) + ' from search centre' : ''}</p>
            </div>
            <button type="button" onclick="$('#detail').classList.add('hidden')" class="text-zinc-400 hover:text-white p-0.5">✕</button>
        </div>

        ${rows.length ? `
            <dl class="space-y-1 py-1 text-[11px]">
                ${rows.map(r => `<div><dt class="text-zinc-400 inline">${r[0]}: </dt><dd class="inline text-zinc-200 font-medium">${esc(r[1])}</dd></div>`).join('')}
            </dl>`
            : '<p class="text-[11px] text-zinc-400 italic">No detailed attributes mapped on OSM yet.</p>'
        }

        <div class="flex flex-wrap gap-1.5 pt-1 border-t border-slate-700/60">
            <button type="button" data-action="add-trip" data-id="${p.id}"
                class="px-2.5 py-1 rounded-md text-[11px] font-semibold transition ${isAdded
                    ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'}">
                ${isAdded ? '✓ Added to Trip' : '+ Add to Trip'}
            </button>
            <button type="button" id="walkRouteBtn" data-id="${p.id}"
                class="px-2 py-1 rounded-md text-[11px] border border-slate-700 bg-slate-800 text-zinc-300 hover:text-white">
                Walk route
            </button>
            <a class="px-2 py-1 rounded-md text-[11px] border border-slate-700 bg-slate-800 text-zinc-300 hover:text-white"
                href="https://www.openstreetmap.org/${p.type}/${p.oid}" target="_blank" rel="noopener noreferrer">
                OSM Info ↗
            </a>
        </div>
    `;
}

function clearSingleRoute() {
    if (singleRouteLayer) {
        map.removeLayer(singleRouteLayer);
        singleRouteLayer = null;
    }
}

async function showSingleRoute(p) {
    if (!origin) return status('error', 'Pick a starting location first.');
    status('load', 'Calculating walking route…');

    try {
        const res = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${origin.lon},${origin.lat};${p.lon},${p.lat}?overview=full&geometries=geojson`);
        if (!res.ok) throw new Error('Route service returned HTTP ' + res.status);
        const rt = (await res.json()).routes?.[0];
        if (!rt) throw new Error('No walking route found between these points.');

        clearSingleRoute();
        singleRouteLayer = L.geoJSON(rt.geometry, {
            style: { color: '#10b981', weight: 5, opacity: 0.9 }
        }).addTo(map);

        map.fitBounds(singleRouteLayer.getBounds(), { padding: [80, 80] });
        status('info', `Walking route: ${fmt(rt.distance)}, est. ${Math.max(1, Math.round(rt.duration / 60))} min.`);
    } catch (e) {
        status('error', netMsg(e));
    }
}

/* ==========================================================
   ONE-TRIP ERRAND PLANNER IMPLEMENTATION
   ========================================================== */

/* ── Save / Restore Trip State ──────────────────────────── */
function saveTrip() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tripStops));
    } catch (e) {
        console.warn('Could not save trip to localStorage:', e);
    }
}

function loadSavedTrip() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                tripStops = parsed.filter(s => s.lat != null && s.lon != null && s.id);
            }
        }
    } catch (e) {
        console.warn('Could not restore saved trip:', e);
        tripStops = [];
    }
}

/* ── Add to Trip ────────────────────────────────────────── */
function addToTrip(place) {
    if (!place) return;

    if (tripStops.some(s => s.id === place.id)) {
        status('info', `"${place.name}" is already in your trip.`);
        return;
    }

    tripStops.push({
        id: place.id,
        type: place.type,
        oid: place.oid,
        lat: place.lat,
        lon: place.lon,
        name: place.name,
        cat: place.cat,
        tags: place.tags || {},
        dist: place.dist
    });

    saveTrip();
    renderTripPanel();
    renderTripMarkers();
    renderResults(); // Update button state to "Added"

    // Invalidate route
    invalidateRoute('Stops modified — click "Plan My Trip" to calculate route.');
    status('info', `Added "${place.name}" as Stop #${tripStops.length}.`);
}

/* ── Remove from Trip ───────────────────────────────────── */
function removeFromTrip(id) {
    const idx = tripStops.findIndex(s => s.id === id);
    if (idx === -1) return;

    const removed = tripStops.splice(idx, 1)[0];
    saveTrip();
    renderTripPanel();
    renderTripMarkers();
    renderResults();

    invalidateRoute('Stop removed — replan to update the route.');
    status('info', `Removed "${removed.name}" from trip.`);
}

/* ── Reorder Trip Stops ─────────────────────────────────── */
function moveTripStop(index, delta) {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= tripStops.length) return;

    const item = tripStops.splice(index, 1)[0];
    tripStops.splice(targetIdx, 0, item);

    saveTrip();
    renderTripPanel();
    renderTripMarkers();

    invalidateRoute('Stops reordered — click "Plan My Trip" to update route.');
}

/* ── Clear Entire Trip ──────────────────────────────────── */
function clearTrip() {
    if (!tripStops.length) return;
    tripStops = [];
    saveTrip();

    if (tripRouteLayer) {
        map.removeLayer(tripRouteLayer);
        tripRouteLayer = null;
    }

    tripMarkersLayer.clearLayers();
    renderTripPanel();
    renderResults();

    $('#summaryDistance').textContent = '—';
    $('#summaryTime').textContent = '—';
    $('#routeStatus').textContent = 'No route planned yet.';
    status('info', 'Trip cleared.');
}

/* ── Invalidate Existing Route ──────────────────────────── */
function invalidateRoute(message) {
    if (tripRouteLayer) {
        map.removeLayer(tripRouteLayer);
        tripRouteLayer = null;
    }
    $('#summaryDistance').textContent = '—';
    $('#summaryTime').textContent = '—';
    $('#routeStatus').textContent = message || 'Route needs recalculation.';
}

/* ── Render Trip Markers on Map ─────────────────────────── */
function renderTripMarkers() {
    tripMarkersLayer.clearLayers();

    tripStops.forEach((stop, index) => {
        const stopNum = index + 1;
        const c = CATS[stop.cat] || { color: '#2563eb' };

        const marker = L.marker([stop.lat, stop.lon], {
            icon: L.divIcon({
                className: '',
                html: `<div class="trip-pin" style="border-color:${c.color}">${stopNum}</div>`,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            }),
            zIndexOffset: 1200 + stopNum
        });

        marker.bindTooltip(`Stop #${stopNum}: ${esc(stop.name)} (${c.one || 'Stop'})`, {
            direction: 'top',
            offset: [0, -16]
        });

        marker.on('click', () => {
            selectPlace(stop.id);
        });

        marker.addTo(tripMarkersLayer);
    });
}

/* ── Render My Trip Panel ───────────────────────────────── */
function renderTripPanel() {
    const listEl = $('#tripStops');
    const badgeEl = $('#tripCountBadge');
    const mobCountEl = $('#mobTripCount');
    const summaryStopsEl = $('#summaryStops');

    const count = tripStops.length;
    if (badgeEl) badgeEl.textContent = `${count} ${count === 1 ? 'stop' : 'stops'}`;
    if (mobCountEl) mobCountEl.textContent = count;
    if (summaryStopsEl) summaryStopsEl.textContent = count;

    if (!listEl) return;

    if (count === 0) {
        listEl.innerHTML = `
            <div id="tripEmptyState" class="py-10 px-4 text-center space-y-2">
                <div class="w-12 h-12 rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center mx-auto text-xl text-slate-400">
                    🗺️
                </div>
                <p class="font-medium text-white text-xs">Your next trip starts here.</p>
                <p class="text-[11px] text-zinc-400">Add places from the Explore panel to build your one-trip route.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = '';

    tripStops.forEach((stop, index) => {
        const c = CATS[stop.cat] || { color: '#3b82f6', one: 'Stop' };
        const stopNum = index + 1;
        const isFirst = index === 0;
        const isLast = index === count - 1;

        const item = document.createElement('div');
        item.className = 'trip-stop-item';
        item.dataset.id = stop.id;

        item.innerHTML = `
            <div class="stop-badge" style="background:${c.color}">${stopNum}</div>
            <div class="flex-1 min-w-0 cursor-pointer" onclick="selectPlace('${stop.id}')">
                <h4 class="font-semibold text-white text-xs truncate">${esc(stop.name)}</h4>
                <p class="text-[11px] text-zinc-400 flex items-center gap-1">
                    <span class="inline-block w-1.5 h-1.5 rounded-full" style="background:${c.color}"></span>
                    ${c.one}
                </p>
            </div>
            <div class="flex items-center gap-1">
                <button type="button" class="move-up-btn p-1 rounded hover:bg-slate-700 text-zinc-400 hover:text-white disabled:opacity-20 transition"
                    title="Move up" data-idx="${index}" ${isFirst ? 'disabled' : ''}>▲</button>
                <button type="button" class="move-down-btn p-1 rounded hover:bg-slate-700 text-zinc-400 hover:text-white disabled:opacity-20 transition"
                    title="Move down" data-idx="${index}" ${isLast ? 'disabled' : ''}>▼</button>
                <button type="button" class="remove-stop-btn p-1 rounded hover:bg-rose-950/60 text-zinc-400 hover:text-rose-400 transition"
                    title="Remove stop" data-id="${stop.id}">✕</button>
            </div>
        `;

        listEl.appendChild(item);
    });
}

/* ── Plan Road Route via OSRM Driving Engine ─────────────── */
async function planTripRoute() {
    if (tripStops.length === 0) {
        status('error', 'Add at least one destination to your trip first.');
        return;
    }

    // Determine route points: [start, ...stops]
    let routePoints = [];

    if (origin) {
        routePoints = [origin, ...tripStops];
    } else {
        if (tripStops.length < 2) {
            status('info', 'Please set a starting location (search or click map) or add another stop to form a route.');
            return;
        }
        routePoints = [...tripStops];
    }

    // Build coordinate pairs formatted for OSRM: lon,lat;lon,lat;...
    const coordsStr = routePoints.map(p => `${p.lon},${p.lat}`).join(';');

    const endpoints = [
        `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`,
        `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`
    ];

    status('load', 'Calculating multi-stop road route…');
    $('#routeStatus').textContent = 'Connecting via OSRM routing engine…';

    let lastError = null;

    for (const url of endpoints) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Routing endpoint HTTP ${res.status}`);
            const data = await res.json();

            if (!data.routes || !data.routes.length) {
                throw new Error('No drivable road route found connecting these coordinates.');
            }

            const primaryRoute = data.routes[0];

            // Clean up existing route
            if (tripRouteLayer) {
                map.removeLayer(tripRouteLayer);
                tripRouteLayer = null;
            }

            // Draw new styled polyline route
            tripRouteLayer = L.geoJSON(primaryRoute.geometry, {
                style: {
                    color: '#38bdf8',
                    weight: 6,
                    opacity: 0.95,
                    lineJoin: 'round',
                    lineCap: 'round'
                }
            }).addTo(map);

            // Fit map bounds to the route comfortably
            map.fitBounds(tripRouteLayer.getBounds(), {
                paddingTopLeft: [60, 60],
                paddingBottomRight: [60, 60]
            });

            // Update UI Summary with real routing response values
            const totalDist = primaryRoute.distance; // in metres
            const totalDur = primaryRoute.duration; // in seconds

            $('#summaryDistance').textContent = fmt(totalDist);
            $('#summaryTime').textContent = fmtTime(totalDur);
            $('#routeStatus').textContent = `Route planned through ${tripStops.length} errands (${origin ? 'from search origin' : 'stop-to-stop'}).`;

            status('info', `Route calculated: ${fmt(totalDist)} total road distance, ~${fmtTime(totalDur)} driving time.`);
            return;

        } catch (err) {
            lastError = err;
            console.warn('Routing endpoint failed:', url, err.message);
        }
    }

    $('#routeStatus').textContent = 'Routing unavailable. Try adjusting coordinates or retry.';
    status('error', 'Routing service unreachable. ' + (lastError?.message || ''));
}

/* ── Event Delegation & Listeners ───────────────────────── */

// 1. Search Form
$('#searchForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    const msg = $('#formMsg');

    if (q.length < 2 || !/\p{L}/u.test(q)) {
        msg.textContent = 'Enter a valid location name (at least 2 letters).';
        $('#q').setAttribute('aria-invalid', 'true');
        return;
    }

    msg.textContent = '';
    $('#q').removeAttribute('aria-invalid');
    status('load', `Searching for "${q}"…`);

    try {
        const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q));
        if (!res.ok) throw new Error('Geocoding service error (' + res.status + ').');
        const d = await res.json();
        if (!d.length) return status('error', `No location found for "${q}". Check spelling or add a city name.`);

        setOrigin(+d[0].lat, +d[0].lon, d[0].display_name);

    } catch (err) {
        status('error', netMsg(err));
    }
});

// Quick-search buttons
$$('.ex').forEach(b => b.addEventListener('click', () => {
    $('#q').value = b.textContent;
    $('#searchForm').requestSubmit();
}));

// Geolocation
$('#locBtn').addEventListener('click', () => {
    if (!navigator.geolocation) {
        return status('error', 'Your browser does not support geolocation. Search for a place instead.');
    }
    status('load', 'Detecting your current location…');
    navigator.geolocation.getCurrentPosition(
        p => setOrigin(p.coords.latitude, p.coords.longitude, 'Your Current Location'),
        err => status('error', err.code === 1 ? 'Location permission was denied. Please allow it or search manually.' : 'Could not detect location. Search for a place instead.'),
        { timeout: 10000 }
    );
});

// Map click to set search origin
map.on('click', e => setOrigin(e.latlng.lat, e.latlng.lng));

// Debounced reload on category or radius change
const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 350);
};

$('#cats').addEventListener('change', reload);

$('#radius').addEventListener('change', () => {
    if (origin) map.setZoom(ZOOM[$('#radius').value] || 15);
    reload();
});

$('#sort').addEventListener('change', renderResults);

// Delegated click for results and place cards
$('#results').addEventListener('click', e => {
    const addBtn = e.target.closest('[data-action="add-trip"]');
    if (addBtn) {
        e.stopPropagation();
        const id = addBtn.dataset.id;
        const p = places.find(x => x.id === id);
        if (p) addToTrip(p);
        return;
    }

    const card = e.target.closest('.place-card');
    if (card) {
        selectPlace(card.dataset.id);
    }
});

// Delegated click in detail panel
$('#detail').addEventListener('click', e => {
    const addBtn = e.target.closest('[data-action="add-trip"]');
    if (addBtn) {
        const id = addBtn.dataset.id;
        const p = places.find(x => x.id === id) || tripStops.find(x => x.id === id);
        if (p) addToTrip(p);
        return;
    }

    const walkBtn = e.target.closest('#walkRouteBtn');
    if (walkBtn) {
        const id = walkBtn.dataset.id;
        const p = places.find(x => x.id === id) || tripStops.find(x => x.id === id);
        if (p) showSingleRoute(p);
    }
});

// Delegated click for trip stops list (Reorder & Remove)
$('#tripStops').addEventListener('click', e => {
    const upBtn = e.target.closest('.move-up-btn');
    if (upBtn) {
        const idx = +upBtn.dataset.idx;
        moveTripStop(idx, -1);
        return;
    }

    const downBtn = e.target.closest('.move-down-btn');
    if (downBtn) {
        const idx = +downBtn.dataset.idx;
        moveTripStop(idx, 1);
        return;
    }

    const rmBtn = e.target.closest('.remove-stop-btn');
    if (rmBtn) {
        removeFromTrip(rmBtn.dataset.id);
        return;
    }
});

// Plan My Trip & Clear Trip buttons
$('#planTripBtn').addEventListener('click', planTripRoute);
$('#clearTripBtn').addEventListener('click', clearTrip);
$('#clearTripHeaderBtn').addEventListener('click', clearTrip);

// Mobile view navigation tabs (< 1024px)
const mobExploreBtn = $('#mobExploreBtn');
const mobTripBtn = $('#mobTripBtn');
const mobMapBtn = $('#mobMapBtn');
const explorePanel = $('#explorePanel');
const tripPanel = $('#tripPanel');

function setMobileView(view) {
    if (window.innerWidth > 1024) return;

    mobExploreBtn.classList.toggle('active', view === 'explore');
    mobTripBtn.classList.toggle('active', view === 'trip');
    mobMapBtn.classList.toggle('active', view === 'map');

    if (view === 'explore') {
        explorePanel.classList.remove('panel-hidden-mobile');
        tripPanel.classList.add('panel-hidden-mobile');
    } else if (view === 'trip') {
        explorePanel.classList.add('panel-hidden-mobile');
        tripPanel.classList.remove('panel-hidden-mobile');
    } else {
        explorePanel.classList.add('panel-hidden-mobile');
        tripPanel.classList.add('panel-hidden-mobile');
    }

    setTimeout(() => map.invalidateSize(), 200);
}

if (mobExploreBtn) mobExploreBtn.addEventListener('click', () => setMobileView('explore'));
if (mobTripBtn) mobTripBtn.addEventListener('click', () => setMobileView('trip'));
if (mobMapBtn) mobMapBtn.addEventListener('click', () => setMobileView('map'));

// Window resize & load handlers
window.addEventListener('load', () => {
    initCategories();
    loadSavedTrip();
    renderTripPanel();
    renderTripMarkers();

    if (window.innerWidth <= 1024) {
        setMobileView('explore');
    }
    map.invalidateSize();
});

window.addEventListener('resize', () => map.invalidateSize());
