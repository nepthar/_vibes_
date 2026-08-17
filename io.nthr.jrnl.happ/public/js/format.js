/** Date and place formatting, matching the iOS app's strings exactly. */

const ORDINALS = new Intl.PluralRules(undefined, { type: 'ordinal' });
const SUFFIXES = { one: 'st', two: 'nd', few: 'rd', other: 'th' };

export const ordinal = (number) => `${number}${SUFFIXES[ORDINALS.select(number)] ?? 'th'}`;

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const month = new Intl.DateTimeFormat(undefined, { month: 'long' });
const year = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullDate = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/**
 * The entry stamp: "Thursday, August 13th, 2026" and, once tagged,
 * "Thursday, August 13th, 2026 ~ Jefferson Park, CO".
 */
export function entryStamp(date, place) {
  const stamp = `${weekday.format(date)}, ${month.format(date)} ${ordinal(date.getDate())}, ${year.format(date)}`;
  return place ? `${stamp} ~ ${place}` : stamp;
}

export const timeLabel = (date) => time.format(date);
export const monthLabel = (date) => monthYear.format(date);

export const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Quiet day headers: "Today", "Yesterday", then the full date. */
export function dayLabel(dayStart) {
  const day = new Date(dayStart);
  const today = startOfDay(new Date());
  const yesterday = today - 86_400_000;
  if (dayStart === today) return 'Today';
  if (dayStart === yesterday) return 'Yesterday';
  return fullDate.format(day);
}

/** "250 m" / "1.4 km" — the nearby-places distance labels. */
export function distanceLabel(meters) {
  if (!Number.isFinite(meters)) return '';
  if (/^en-US/i.test(navigator.language ?? '')) {
    const feet = meters * 3.28084;
    return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(feet / 5280).toFixed(1)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

/** An entry's text content, blocks joined the way the iOS `plainText` does. */
export const plainText = (entry) =>
  entry.blocks
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n');

export const mediaCount = (entry) =>
  entry.blocks.filter((block) => block.kind === 'media').length;
