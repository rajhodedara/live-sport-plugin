/**
 * Parses a date string and a timezone into a stable UTC UNIX timestamp (milliseconds).
 * 
 * @param {string|number} dateValue - The date string or UNIX timestamp.
 * @param {string} [timeZone='America/New_York'] - IANA Timezone string (e.g., 'America/New_York', 'UTC').
 * @returns {number|null} - UTC UNIX timestamp in milliseconds, or null if invalid.
 */
function parseTimezone(dateValue, timeZone = 'America/New_York') {
  if (dateValue === null || dateValue === undefined) return null;

  // If it's already a valid number (UNIX timestamp), return it (assuming milliseconds if > 1e11)
  if (typeof dateValue === 'number') {
    if (!Number.isFinite(dateValue) || dateValue <= 0) return null;
    return dateValue < 1e11 ? dateValue * 1000 : dateValue;
  }

  const str = String(dateValue).trim();
  if (!str || str === '0') return null;

  // If it's a numeric string representing a timestamp
  const numeric = Number(str);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }

  // If the string contains an explicit explicit timezone offset like Z or +05:30
  // we can just let native Date parse it, as it overrides local timezone assumptions
  const hasTimezoneOffset = str.endsWith('Z') || str.match(/[+-]\d{2}:?\d{2}$/);
  if (hasTimezoneOffset) {
    const t = new Date(str).getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  // Replace spaces with T for proper ISO format compatibility
  const cleanStr = str.replace(' ', 'T');
  
  // We treat the incoming local time string as if it were UTC.
  // Example: "2026-08-16T16:05" -> "2026-08-16T16:05Z"
  const localDate = new Date(cleanStr + 'Z');
  if (isNaN(localDate.getTime())) return null;

  // Format this time in the target timezone to determine the offset.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(localDate);
  const p = {};
  parts.forEach(part => { p[part.type] = part.value; });
  
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // Intl.DateTimeFormat can return 24 for midnight
  const hourStr = hour.toString().padStart(2, '0');
  
  // Create a UTC date representing what the time actually is in the target timezone
  const formattedStr = `${p.year}-${p.month}-${p.day}T${hourStr}:${p.minute}:${p.second}Z`;
  const formattedDate = new Date(formattedStr);
  
  // The difference between localDate and formattedDate is the exact timezone offset for that specific moment.
  const offsetMs = localDate.getTime() - formattedDate.getTime();
  
  // Apply the offset to get the true UTC UNIX timestamp
  const trueUtcTime = localDate.getTime() + offsetMs;
  return trueUtcTime > 0 ? trueUtcTime : null;
}

module.exports = { parseTimezone };
