export type ReverieWeatherKind = 'clear' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow' | 'heat';

const HOUR = 3_600_000;
const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});
const descriptions: Record<ReverieWeatherKind, string> = {
  clear: 'Clear sky over the city.',
  overcast: 'A broad layer of cloud covers the city.',
  rain: 'Steady rain patters on roofs and ripples the water.',
  storm: 'Heavy rain, gusting wind, and distant rolling thunder.',
  fog: 'Low fog drifts along the water and softens the streets.',
  snow: 'Snow settles softly on railings and rooftops.',
  heat: 'Hot, still air; the shade offers a little relief.',
};

function noise(slot: number, salt: string): number {
  let value = 2166136261;
  for (const char of `${salt}:${slot}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0xffffffff;
}

/** Continuous fronts use absolute time: midnight, DST, and restarts cannot reroll the sky. */
function front(at: number, hours: number, salt: string): number {
  const phase = at / (HOUR * hours);
  const slot = Math.floor(phase);
  const fraction = phase - slot;
  const blend = fraction * fraction * (3 - 2 * fraction);
  return noise(slot, salt) * (1 - blend) + noise(slot + 1, salt) * blend;
}

export function reverieWeather(at: Date = new Date()): {
  kind: ReverieWeatherKind;
  line: string;
  temperatureC: number;
  wind: string;
} {
  const timestamp = at.getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError('Weather needs a valid date.');
  const parts = calendar.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const month = part('month');
  const hour = part('hour') + part('minute') / 60;
  const yearPhase = (month - 1 + (part('day') - 1) / 31) / 12;
  const seasonal = 12 - 14 * Math.cos(2 * Math.PI * yearPhase);
  const daily = 3 * Math.cos(((hour - 15) * Math.PI) / 12);
  const temperatureC = Math.round(
    seasonal + daily + (front(timestamp, 72, 'temperature') - 0.5) * 10,
  );
  const moisture = front(timestamp, 12, 'moisture');
  let kind: ReverieWeatherKind = 'clear';
  if (moisture >= 0.62) {
    kind = 'rain';
    if (temperatureC <= 1) kind = 'snow';
    else if (moisture >= 0.87 && temperatureC >= 12) kind = 'storm';
  } else if (moisture >= 0.4)
    kind = hour < 9 && moisture < 0.54 && temperatureC > 0 ? 'fog' : 'overcast';
  else if (temperatureC >= 30 && hour >= 10 && hour < 20) kind = 'heat';
  let wind = front(timestamp, 18, 'wind') > 0.65 ? 'breezy' : 'light';
  if (kind === 'storm') wind = 'gusting';
  const fahrenheit = Math.round((temperatureC * 9) / 5 + 32);
  return {
    kind,
    temperatureC,
    wind,
    line: `${descriptions[kind]} About ${fahrenheit} degrees Fahrenheit (${temperatureC} Celsius), with ${wind} wind.`,
  };
}

export function reverieForecast(at: Date = new Date()): string[] {
  return [0, 3, 6, 12].map((hours) => {
    const weather = reverieWeather(new Date(at.getTime() + hours * HOUR));
    return `${hours ? `In ${hours} hours` : 'Now'}: ${weather.line}`;
  });
}
