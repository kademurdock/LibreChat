const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeLocation — blind-first "where am I / what's around me / walk me there"
 * (July 23 2026, from MAPS_GPS_WORKUP_2026-07-16.md, Kade-approved slice 1+2).
 *
 * Location comes from the USER'S OWN DEVICE: the web/native clients attach
 * `userLocation: {lat, lon, accuracy, at}` to the chat request body only when
 * the user's "Share my location" setting is ON (off by default). No location
 * attached = this tool says so and points at the setting — it never guesses.
 *
 * Providers (all free tiers, per their published policies, family-scale):
 *   - Nominatim (OpenStreetMap) reverse/forward geocoding — 1 req/sec max,
 *     real User-Agent. We pace AND cache (15 min, ~110m coordinate bins).
 *   - Overpass API "what's around" POIs — small radius queries are the
 *     favored kind; kumi.systems mirror as fallback.
 *   - Valhalla (FOSSGIS public instance) pedestrian routing — returns spoken
 *     maneuver instructions natively. (The public OSRM demo only hosts the
 *     car profile, so Valhalla is the walking-directions pick.)
 * Fail-soft EVERYWHERE: any provider trouble = a warm "can't tell right now"
 * sentence, never a thrown error, never invented geography.
 */

const UA = 'Kade-AI/1.0 (https://kademurdock.com; kademurdock@gmail.com)';
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OVERPASS_MAIN = 'https://overpass-api.de/api/interpreter';
const OVERPASS_MIRROR = 'https://overpass.kumi.systems/api/interpreter';
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';

const CANT =
  "I can't tell where you are right now. If you want me to, turn on \"Share my location\" in Settings, then ask again.";
const STALE =
  'The location your app shared is a little old — give it a second to catch a fresh fix and ask again.';

/** Nominatim policy: never more than 1 request/second. One in-process gate. */
let _lastNominatimAt = 0;
async function nominatim(path, params) {
  const wait = _lastNominatimAt + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNominatimAt = Date.now();
  const r = await axios.get(`${NOMINATIM}${path}`, {
    params: { format: 'jsonv2', ...params },
    headers: { 'User-Agent': UA },
    timeout: 10000,
  });
  return r.data;
}

/** Reverse-geocode cache: ~110m bins, 15 minutes — standing still or pacing
 * a room never re-asks Nominatim. */
const _revCache = new Map();
async function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = _revCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.data;
  const data = await nominatim('/reverse', { lat, lon, zoom: 18, addressdetails: 1 });
  _revCache.set(key, { at: Date.now(), data });
  if (_revCache.size > 200) _revCache.delete(_revCache.keys().next().value);
  return data;
}

const FT_PER_M = 3.28084;
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function compass(lat1, lon1, lat2, lon2) {
  const y = Math.sin(((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.cos(((lon2 - lon1) * Math.PI) / 180);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return dirs[Math.round(deg / 45) % 8];
}

/** Spoken distance: feet under a quarter mile, otherwise miles. */
function spokenDistance(meters) {
  const feet = meters * FT_PER_M;
  if (feet < 1320) return `about ${Math.max(10, Math.round(feet / 10) * 10)} feet`;
  const miles = feet / 5280;
  return `about ${miles < 2 ? miles.toFixed(1) : Math.round(miles)} mile${miles >= 1.05 ? 's' : ''}`;
}

/** Friendly category → OSM tag filters. 'anything' = a general amenity mix. */
const CATEGORIES = {
  pharmacy: ['node["amenity"="pharmacy"]', 'node["shop"="chemist"]'],
  food: ['node["amenity"~"restaurant|fast_food|cafe|ice_cream"]'],
  restaurant: ['node["amenity"="restaurant"]'],
  coffee: ['node["amenity"="cafe"]'],
  groceries: ['node["shop"~"supermarket|convenience|greengrocer"]'],
  gas: ['node["amenity"="fuel"]'],
  bank: ['node["amenity"~"bank|atm"]'],
  bus: ['node["highway"="bus_stop"]'],
  doctor: ['node["amenity"~"doctors|clinic|hospital"]'],
  church: ['node["amenity"="place_of_worship"]'],
  school: ['node["amenity"~"school|kindergarten"]'],
  park: ['node["leisure"~"park|playground"]'],
  hotel: ['node["tourism"~"hotel|motel"]'],
  shopping: ['node["shop"]'],
  anything: ['node["amenity"]', 'node["shop"]', 'node["highway"="bus_stop"]', 'node["leisure"~"park|playground"]'],
};

async function overpass(query) {
  for (const base of [OVERPASS_MAIN, OVERPASS_MIRROR]) {
    try {
      const r = await axios.post(base, `data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      return r.data;
    } catch (err) {
      logger.warn(`[kade_location] overpass ${base} failed: ${err.message}`);
    }
  }
  return null;
}

function describePlace(addr) {
  if (!addr) return null;
  const road = addr.road || addr.pedestrian || addr.footway || addr.cycleway;
  const locality =
    addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.county;
  const house = addr.house_number;
  const poi =
    addr.amenity || addr.shop || addr.building === 'yes' ? null : addr.building;
  const bits = [];
  if (road) bits.push(house ? `near ${house} ${road}` : `on ${road}`);
  if (addr.neighbourhood && !bits.length) bits.push(`in ${addr.neighbourhood}`);
  if (locality) bits.push(bits.length ? `in ${locality}` : `in ${locality}`);
  if (addr.state && locality) bits[bits.length - 1] += `, ${addr.state}`;
  return { line: bits.join(' '), poi };
}

const locationJsonSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['where_am_i', 'whats_around', 'walk_me_there'],
      description:
        "'where_am_i' speaks the street/area they're at; 'whats_around' lists nearby places by distance and direction; 'walk_me_there' gives spoken walking directions to a destination.",
    },
    category: {
      type: 'string',
      description:
        "For whats_around: pharmacy, food, restaurant, coffee, groceries, gas, bank, bus, doctor, church, school, park, hotel, shopping, or 'anything' (default).",
    },
    radius_feet: {
      type: 'integer',
      description: 'For whats_around: search radius in feet, 200-5280. Default 1000 (a couple of blocks).',
    },
    destination: {
      type: 'string',
      description:
        "For walk_me_there: where they want to go — a place name or address ('Walgreens', '414 W Main St'). Nearest match to their position wins.",
    },
  },
  required: ['action'],
};

class KadeLocation extends Tool {
  constructor(fields = {}) {
    super();
    this.name = 'kade_location';
    this.description =
      'REAL location awareness for THIS user, from their own device (only when their "Share my location" setting is on). ' +
      "Use for: 'where am I' (spoken street/area), 'what's around me' (nearby places with distance and walking direction), " +
      "and 'walk me there' (spoken walking directions). Blind-first: answers are complete sentences ready to speak. " +
      'NEVER guess or invent locations, distances, or directions — only report what this tool returns. ' +
      'If it says location is unavailable, relay that warmly and mention the Settings toggle.';
    this.schema = locationJsonSchema;
    /** {lat, lon, accuracy, at} ridden along on the request body by the app when the setting is on. */
    this.userLocation = fields.req?.body?.userLocation || null;
  }

  _fix() {
    const loc = this.userLocation;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return { err: CANT };
    if (Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) return { err: CANT };
    if (loc.at && Date.now() - new Date(loc.at).getTime() > 10 * 60 * 1000) return { err: STALE };
    return { lat: loc.lat, lon: loc.lon };
  }

  async _call(data) {
    const { action } = data || {};
    try {
      if (action === 'where_am_i') return await this.whereAmI();
      if (action === 'whats_around') return await this.whatsAround(data);
      if (action === 'walk_me_there') return await this.walkMeThere(data);
      return "I need an action: where_am_i, whats_around, or walk_me_there.";
    } catch (err) {
      logger.error('[kade_location] error:', err);
      return "I couldn't check the map just now — the free map service didn't answer. Worth another try in a minute.";
    }
  }

  async whereAmI() {
    const fix = this._fix();
    if (fix.err) return fix.err;
    const rev = await reverseGeocode(fix.lat, fix.lon);
    const desc = describePlace(rev?.address);
    if (!desc || !desc.line) return "The map service couldn't name this spot. Try again in a minute.";
    const nameBit =
      rev?.name && rev.name !== '' && !desc.line.toLowerCase().includes(rev.name.toLowerCase())
        ? ` That's right at ${rev.name}.`
        : '';
    return `You're ${desc.line}.${nameBit}`;
  }

  async whatsAround(data) {
    const fix = this._fix();
    if (fix.err) return fix.err;
    const category = (data?.category || 'anything').toLowerCase().trim();
    const filters = CATEGORIES[category] || CATEGORIES.anything;
    const radiusFt = Math.min(5280, Math.max(200, parseInt(data?.radius_feet, 10) || 1000));
    const radiusM = Math.round(radiusFt / FT_PER_M);
    const around = `(around:${radiusM},${fix.lat},${fix.lon})`;
    const q = `[out:json][timeout:10];(${filters.map((f) => `${f}${around};`).join('')});out body 30;`;
    const res = await overpass(q);
    if (!res) return "The nearby-places service didn't answer just now. Worth another try in a minute.";
    const seen = new Set();
    const places = (res.elements || [])
      .filter((e) => e.tags && (e.tags.name || e.tags.amenity || e.tags.shop || e.tags.highway))
      .map((e) => {
        const label =
          e.tags.name ||
          (e.tags.highway === 'bus_stop'
            ? 'a bus stop'
            : `a ${String(e.tags.amenity || e.tags.shop || 'place').replace(/_/g, ' ')}`);
        return {
          label,
          meters: haversineMeters(fix.lat, fix.lon, e.lat, e.lon),
          dir: compass(fix.lat, fix.lon, e.lat, e.lon),
        };
      })
      .filter((p) => {
        const k = p.label.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.meters - b.meters)
      .slice(0, 6);
    if (!places.length) {
      return `Nothing ${category === 'anything' ? '' : `matching "${category}" `}within ${spokenDistance(radiusM)} on the map. Want me to widen the search?`;
    }
    const lines = places.map((p) => `${p.label}, ${spokenDistance(p.meters)} to the ${p.dir}`);
    return `Within ${spokenDistance(radiusM)}, closest first: ${lines.join('; ')}.`;
  }

  async walkMeThere(data) {
    const fix = this._fix();
    if (fix.err) return fix.err;
    const destination = String(data?.destination || '').trim();
    if (!destination) return 'Where to? Give me a place name or an address.';
    // Forward-geocode, biased hard to their neighborhood (viewbox + bounded).
    const d = 0.09; // ~6 miles
    const results = await nominatim('/search', {
      q: destination,
      limit: 5,
      addressdetails: 1,
      viewbox: `${fix.lon - d},${fix.lat + d},${fix.lon + d},${fix.lat - d}`,
      bounded: 1,
    });
    const target = Array.isArray(results) && results.length
      ? results
          .map((r) => ({
            r,
            meters: haversineMeters(fix.lat, fix.lon, parseFloat(r.lat), parseFloat(r.lon)),
          }))
          .sort((a, b) => a.meters - b.meters)[0]
      : null;
    if (!target) {
      return `I couldn't find "${destination}" within a few miles of you. Try the full name or an address.`;
    }
    const tLat = parseFloat(target.r.lat);
    const tLon = parseFloat(target.r.lon);
    const route = await axios.post(
      VALHALLA,
      {
        locations: [
          { lat: fix.lat, lon: fix.lon },
          { lat: tLat, lon: tLon },
        ],
        costing: 'pedestrian',
        units: 'miles',
        language: 'en-US',
      },
      { headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, timeout: 15000 },
    );
    const leg = route.data?.trip?.legs?.[0];
    const summary = route.data?.trip?.summary;
    if (!leg || !Array.isArray(leg.maneuvers) || !leg.maneuvers.length) {
      return "The walking-directions service didn't answer just now. Worth another try in a minute.";
    }
    const name = target.r.name || target.r.display_name?.split(',')[0] || destination;
    const totalMeters = (summary?.length || 0) * 1609.34;
    const minutes = Math.max(1, Math.round((summary?.time || 0) / 60));
    const steps = leg.maneuvers
      .map((m) => {
        const inst = String(m.instruction || '').replace(/\.$/, '');
        if (!inst || /^You have arrived/i.test(inst)) return null;
        const lenM = (m.length || 0) * 1609.34;
        return lenM >= 15 ? `${inst}, ${spokenDistance(lenM)}` : inst;
      })
      .filter(Boolean);
    return (
      `Walking to ${name} — ${spokenDistance(totalMeters)}, about ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
      `${steps.join('. ')}. You'll be there. ` +
      'Heads up: these are map directions, not eyes — crossings, construction, and curbs are yours to judge, and the Spotter is one call away if you want live help.'
    );
  }
}

module.exports = KadeLocation;
