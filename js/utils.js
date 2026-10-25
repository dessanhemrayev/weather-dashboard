'use strict';

/**
 * Откладывает вызов fn, пока не пройдёт delay мс без новых вызовов.
 * У результата есть cancel() и flush(): первый отбрасывает ожидающий вызов,
 * второй выполняет его сразу.
 */
export function debounce(fn, delay) {
  let timer = null;
  let pendingArgs = null;

  const debounced = (...args) => {
    pendingArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const callArgs = pendingArgs;
      pendingArgs = null;
      fn(...callArgs);
    }, delay);
  };

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    pendingArgs = null;
  };

  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const callArgs = pendingArgs;
    pendingArgs = null;
    fn(...callArgs);
  };

  return debounced;
}

export const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

const dayFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function formatTemp(value) {
  return isNum(value) ? `${Math.round(value)}°` : '—';
}

export function formatWind(value) {
  return isNum(value) ? `${Math.round(value)} км/ч` : '—';
}

export function formatPrecip(value) {
  return isNum(value) ? `${value.toFixed(1)} мм` : '—';
}

export function formatPercent(value) {
  return isNum(value) ? `${Math.round(value)}%` : '—';
}

/** 'YYYY-MM-DD' → «вт, 4 нояб.». Разбираем вручную, чтобы дату не сдвинул часовой пояс. */
export function formatDay(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate));
  if (!match) return '—';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? '—' : dayFormat.format(date);
}

export function formatTime(timestamp) {
  return isNum(timestamp) ? timeFormat.format(new Date(timestamp)) : '—';
}
