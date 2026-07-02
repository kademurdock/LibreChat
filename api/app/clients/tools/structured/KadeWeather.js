const axios = require('axios');
const { Tool } = require('@librechat/agents/langchain/tools');
const { logger } = require('@librechat/data-schemas');

const weatherJsonSchema = {
  type: 'object',
  properties: {
    location: {
      type: 'string',
      description: "City or place name, optionally with region (e.g. 'Ozark, Missouri' or 'Springfield MO').",
    },
    days: {
      type: 'integer',
      description: 'Forecast days to include (1-7). Default 3. Use 1 for "right now / today".',
    },
  },
  required: ['location'],
};

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

/**
 * KadeWeather — real weather via Open-Meteo. Completely free, no API key,
 * no per-call cost (nothing to bill to the user's tab).
 */
class KadeWeather extends Tool {
  constructor() {
    super();
    this.name = 'kade_weather';
    this.description =
      'Get REAL current weather and a short forecast for any city, free and instantly (Open-Meteo, no key, no cost). ' +
      'Use this instead of web_search for any weather question. Returns temperatures in Fahrenheit, conditions, ' +
      'precipitation chance, and wind. NEVER invent weather — only report what this tool returns.';
    this.schema = weatherJsonSchema;
  }

  async _call(data) {
    const { location, days } = data || {};
    if (!location) return 'I need a location.';
    const nDays = Math.min(7, Math.max(1, parseInt(days, 10) || 3));
    try {
      // Open-Meteo's geocoder matches on the place NAME only — "Ozark, Missouri"
      // returns nothing. Split off any region hint and use it to pick among results.
      const [namePart, ...regionParts] = String(location).split(',');
      const regionHint = regionParts.join(' ').trim().toLowerCase();
      const geo = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
        params: { name: namePart.trim(), count: 5, language: 'en', format: 'json' },
        timeout: 10000,
      });
      const results = geo.data?.results || [];
      const place = (regionHint
        ? results.find((r) =>
            [r.admin1, r.admin2, r.country]
              .filter(Boolean)
              .some((x) => x.toLowerCase().includes(regionHint) || regionHint.includes(x.toLowerCase())),
          )
        : null) || results[0];
      if (!place) return `I couldn't find a place called "${location}". Try a different spelling or a bigger nearby city.`;
      const w = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: place.latitude,
          longitude: place.longitude,
          current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max',
          temperature_unit: 'fahrenheit',
          wind_speed_unit: 'mph',
          precipitation_unit: 'inch',
          forecast_days: nDays,
          timezone: 'auto',
        },
        timeout: 10000,
      });
      const c = w.data.current;
      const d = w.data.daily;
      const lines = [
        `Weather for ${place.name}${place.admin1 ? ', ' + place.admin1 : ''} (${w.data.timezone}):`,
        `NOW: ${Math.round(c.temperature_2m)}°F (feels like ${Math.round(c.apparent_temperature)}°F), ${WMO[c.weather_code] || 'unknown'}, humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} mph.`,
      ];
      for (let i = 0; i < (d.time || []).length; i++) {
        lines.push(
          `${d.time[i]}: ${WMO[d.weather_code[i]] || ''}, high ${Math.round(d.temperature_2m_max[i])}°F / low ${Math.round(d.temperature_2m_min[i])}°F, precip chance ${d.precipitation_probability_max?.[i] ?? '?'}%, wind up to ${Math.round(d.wind_speed_10m_max[i])} mph.`,
        );
      }
      return lines.join('\n');
    } catch (err) {
      logger.warn(`[KadeWeather] failed: ${err.message}`);
      return `Weather lookup failed: ${err.message}`;
    }
  }
}

module.exports = KadeWeather;
