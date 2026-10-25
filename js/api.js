'use strict';

/**
 * Работа с сетью. Модуль ничего не знает ни о состоянии, ни о DOM:
 * принимает параметры, возвращает чистые данные или бросает ApiError.
 */
import { isNum } from './utils.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_TIMEOUT_MS = 10000;

/** kind: 'network' | 'timeout' | 'http' | 'parse' | 'data' */
export class ApiError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export const isAbortError = (error) => Boolean(error) && error.name === 'AbortError';

const abortError = () => new DOMException('Запрос отменён', 'AbortError');

function httpMessage(status) {
  if (status === 429) return 'Слишком много запросов. Подождите минуту и повторите';
  if (status >= 500) return 'Сервис Open-Meteo временно недоступен';
  return `Сервис отклонил запрос (код ${status})`;
}

/**
 * GET-запрос с разбором JSON. Внешний signal отменяет запрос (AbortError),
 * собственный таймер обрывает зависший запрос (ApiError 'timeout').
 */
async function requestJson(url, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) throw abortError();

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  let timedOut = false;
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Превращает любой сбой в нужный тип ошибки: отмена, таймаут или сеть.
  const classify = (error) => {
    if (error instanceof ApiError) return error;
    if (timedOut) return new ApiError('timeout', 'Сервер не ответил вовремя. Повторите попытку');
    if (signal && signal.aborted) return abortError();
    return null;
  };

  try {
    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      throw classify(error) || new ApiError('network', 'Нет связи с сервером. Проверьте интернет');
    }

    if (!response.ok) throw new ApiError('http', httpMessage(response.status), response.status);

    try {
      return await response.json();
    } catch (error) {
      throw classify(error) || new ApiError('parse', 'Сервер вернул ответ в непонятном формате');
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

const cleanText = (value) => (typeof value === 'string' ? value.trim().slice(0, 100) : '');

function normalizeCity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanText(raw.name);
  if (!name || !isNum(raw.latitude) || !isNum(raw.longitude)) return null;
  if (Math.abs(raw.latitude) > 90 || Math.abs(raw.longitude) > 180) return null;
  const id = isNum(raw.id)
    ? String(raw.id)
    : `${raw.latitude.toFixed(3)},${raw.longitude.toFixed(3)}`;
  return {
    id,
    name,
    country: cleanText(raw.country),
    admin1: cleanText(raw.admin1),
    latitude: raw.latitude,
    longitude: raw.longitude,
  };
}

/** Ищет города по названию. Пустой список означает «ничего не найдено». */
export async function searchCities(query, { signal } = {}) {
  const name = String(query).trim();
  const params = new URLSearchParams({ name, count: '8', language: 'ru', format: 'json' });
  const data = await requestJson(`${GEOCODING_URL}?${params}`, { signal });
  if (!data || typeof data !== 'object') {
    throw new ApiError('parse', 'Сервер вернул ответ в непонятном формате');
  }
  // Если совпадений нет, Open-Meteo присылает объект без поля results.
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map(normalizeCity).filter(Boolean);
}

const numberOrNull = (value) => (isNum(value) ? value : null);

function normalizeForecast(item) {
  if (!item || typeof item !== 'object') return null;
  const current = item.current;
  const daily = item.daily;
  if (!current || typeof current !== 'object') return null;
  if (!daily || !Array.isArray(daily.time) || daily.time.length === 0) return null;

  const column = (key) => (Array.isArray(daily[key]) ? daily[key] : []);
  const codes = column('weather_code');
  const tmax = column('temperature_2m_max');
  const tmin = column('temperature_2m_min');
  const precip = column('precipitation_sum');
  const wind = column('wind_speed_10m_max');

  return {
    current: {
      time: typeof current.time === 'string' ? current.time : null,
      temp: numberOrNull(current.temperature_2m),
      feels: numberOrNull(current.apparent_temperature),
      humidity: numberOrNull(current.relative_humidity_2m),
      wind: numberOrNull(current.wind_speed_10m),
      code: numberOrNull(current.weather_code),
    },
    daily: daily.time.map((date, i) => ({
      date: String(date),
      code: numberOrNull(codes[i]),
      tmax: numberOrNull(tmax[i]),
      tmin: numberOrNull(tmin[i]),
      precip: numberOrNull(precip[i]),
      wind: numberOrNull(wind[i]),
    })),
  };
}

/**
 * Загружает прогноз для всех городов одним запросом (Open-Meteo принимает
 * списки координат). Возвращает объект {id города: прогноз}.
 */
export async function fetchForecasts(cities, { signal } = {}) {
  if (!Array.isArray(cities) || cities.length === 0) return {};

  const params = new URLSearchParams({
    latitude: cities.map((city) => city.latitude).join(','),
    longitude: cities.map((city) => city.longitude).join(','),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
    timezone: 'auto',
    forecast_days: '7',
  });
  const data = await requestJson(`${FORECAST_URL}?${params}`, { signal });

  // Для одной точки ответ — объект, для нескольких — массив.
  const items = Array.isArray(data) ? data : [data];
  const result = {};
  cities.forEach((city, index) => {
    const forecast = normalizeForecast(items[index]);
    if (forecast) result[city.id] = forecast;
  });

  if (Object.keys(result).length === 0) {
    throw new ApiError('data', 'Сервис не вернул данных о погоде');
  }
  return result;
}
