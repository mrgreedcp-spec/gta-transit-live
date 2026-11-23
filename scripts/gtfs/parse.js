import { stat } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { parse } from 'csv-parse';

export const LIMITS = Object.freeze({ zipBytes: 256 * 1024 * 1024, expandedBytes: 3 * 1024 ** 3, entries: 2000, recordBytes: 256 * 1024 });
const REQUIRED_FILES = ['agency.txt', 'stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
const COLUMNS = {
  'agency.txt': ['agency_name', 'agency_url', 'agency_timezone'],
  'stops.txt': ['stop_id', 'stop_name'],
  'routes.txt': ['route_id', 'route_type'],
  'calendar.txt': ['service_id','monday','tuesday','wednesday','thursday','friday','saturday','sunday','start_date','end_date'],
  'calendar_dates.txt': ['service_id','date','exception_type'],
  'trips.txt': ['route_id','service_id','trip_id'],
  'stop_times.txt': ['trip_id','stop_id','stop_sequence','arrival_time','departure_time'],
  'feed_info.txt': ['feed_publisher_name','feed_publisher_url','feed_lang'],
};

export class GtfsError extends Error {
  constructor(message, code = 'INVALID_GTFS') { super(message); this.name = 'GtfsError'; this.code = code; }
}
export const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new GtfsError(`Missing ${name}.`);
  if (value.length > 8192) throw new GtfsError(`${name} exceeds the supported length.`);
  return value.trim();
};
export function integer(value, name, { min = 0, max = 2147483647, fallback = null } = {}) {
  if (value == null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new GtfsError(`Invalid integer in ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new GtfsError(`Out-of-range ${name}.`);
  return number;
}
export function date(value, name = 'date', optional = false) {
  if (!value && optional) return null;
  if (!/^\d{8}$/.test(value || '')) throw new GtfsError(`Invalid ${name}; expected YYYYMMDD.`);
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== iso) throw new GtfsError(`Invalid calendar date in ${name}.`);
  return iso;
}
export function seconds(value, name = 'time') {
  if (value == null || value === '') return null;
  // GTFS explicitly permits hours above 24. 999 is a generous input bound.
  if (!/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(value)) throw new GtfsError(`Invalid GTFS ${name}.`);
  const [h,m,s] = value.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}
function coordinate(value, name, maximum, needed) {
  if (value == null || value === '') { if (needed) throw new GtfsError(`Missing ${name}.`); return null; }
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new GtfsError(`Invalid ${name}.`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > maximum) throw new GtfsError(`Out-of-range ${name}.`);
  return number;
}
function color(value) {
  if (!value) return null;
  if (!/^[\da-fA-F]{6}$/.test(value)) throw new GtfsError('Invalid GTFS route color.');
  return value.toUpperCase();
}
function url(value, field) {
  const text = required(value, field);
  let parsed;
  try { parsed = new URL(text); } catch { throw new GtfsError(`Invalid ${field}.`); }
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new GtfsError(`Invalid ${field}.`);
  return text;
}

export function validateRow(file, row) {
  const id = (field) => required(row[field], field);
  const opt = (field) => row[field]?.trim() || null;
  const int = (field, max = 2147483647, fallback = 0) => integer(row[field], field, { max, fallback });
  switch (file) {
    case 'agency.txt': {
      const timezone = id('agency_timezone');
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new GtfsError('Invalid agency_timezone.'); }
      return [opt('agency_id') || '', id('agency_name'), url(row.agency_url, 'agency_url'), timezone];
    }
    case 'stops.txt': {
      const kind = int('location_type', 4);
      return [id('stop_id'), opt('stop_code'), kind <= 2 ? id('stop_name') : (opt('stop_name') || ''),
        coordinate(row.stop_lat,'stop_lat',90,kind <= 2), coordinate(row.stop_lon,'stop_lon',180,kind <= 2),
        kind, opt('parent_station'), int('wheelchair_boarding',2)];
    }
    case 'routes.txt': {
      if (!opt('route_short_name') && !opt('route_long_name')) throw new GtfsError('Route needs a short or long name.');
      return [id('route_id'), opt('agency_id'), opt('route_short_name') || '', opt('route_long_name') || '',
        integer(id('route_type'),'route_type'), color(row.route_color), color(row.route_text_color)];
    }
    case 'calendar.txt': {
      const start = date(row.start_date,'start_date'), end = date(row.end_date,'end_date');
      if (end < start) throw new GtfsError('Calendar end_date precedes start_date.');
      const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(k => integer(id(k),k,{max:1}) === 1);
      return [id('service_id'), ...days, start, end];
    }
    case 'calendar_dates.txt': return [id('service_id'), date(row.date), integer(id('exception_type'),'exception_type',{min:1,max:2})];
    case 'trips.txt': return [id('trip_id'), id('route_id'), id('service_id'), opt('trip_headsign'), int('direction_id',1,null), opt('shape_id'), int('wheelchair_accessible',2)];
    case 'stop_times.txt': {
      const arrival = seconds(row.arrival_time,'arrival_time'), departure = seconds(row.departure_time,'departure_time');
      const point = int('timepoint',1,1);
      if (point === 1 && (arrival === null || departure === null)) throw new GtfsError('Exact timepoint needs arrival_time and departure_time.');
      if (arrival !== null && departure !== null && departure < arrival) throw new GtfsError('Departure precedes arrival.');
      return [id('trip_id'), integer(id('stop_sequence'),'stop_sequence'), id('stop_id'), arrival, departure,
        int('pickup_type',3), int('drop_off_type',3), point];
    }
    case 'feed_info.txt': {
      const start = date(row.feed_start_date,'feed_start_date',true), end = date(row.feed_end_date,'feed_end_date',true);
      if ((start === null) !== (end === null) || (start && end < start)) throw new GtfsError('Invalid feed validity interval.');
      return { publisherName:id('feed_publisher_name'), publisherUrl:url(row.feed_publisher_url,'feed_publisher_url'), version:opt('feed_version'), validFrom:start, validUntil:end };
    }
    default: throw new GtfsError('Unsupported GTFS file.');
  }
}

export async function openArchive(file, limits = LIMITS) {
  if ((await stat(file)).size > limits.zipBytes) throw new GtfsError('GTFS archive exceeds the compressed size limit.','ZIP_LIMIT');
  const zip = await new Promise((resolve,reject) => yauzl.open(file,{lazyEntries:true,autoClose:false,validateEntrySizes:true},(error,z) => error ? reject(error) : resolve(z)));
  const entries = new Map();
  try {
    await new Promise((resolve,reject) => {
      let count = 0, expanded = 0;
      zip.on('error',reject);
      zip.on('entry', entry => {
        try {
          if (++count > limits.entries) throw new GtfsError('Too many ZIP entries.','ZIP_LIMIT');
          const name = entry.fileName;
          if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name) || name.includes('\0')) throw new GtfsError('Unsafe ZIP entry path.','ZIP_PATH');
          if ((entry.generalPurposeBitFlag & 1) || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new GtfsError('Encrypted or symbolic-link ZIP entries are unsupported.','ZIP_TYPE');
          expanded += entry.uncompressedSize;
          if (expanded > limits.expandedBytes) throw new GtfsError('GTFS archive exceeds expanded size limit.','ZIP_LIMIT');
          if (!name.endsWith('/')) {
            const base = path.posix.basename(name);
            if (Object.hasOwn(COLUMNS,base)) {
              if (entries.has(base)) throw new GtfsError(`Duplicate ${base} in ZIP.`,'ZIP_DUPLICATE');
              entries.set(base,entry);
            }
          }
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.on('end',resolve);
      zip.readEntry();
    });
    for (const needed of REQUIRED_FILES) if (!entries.has(needed)) throw new GtfsError(`Missing ${needed}.`);
    if (!entries.has('calendar.txt') && !entries.has('calendar_dates.txt')) throw new GtfsError('Missing service calendar.');
  } catch (error) { zip.close(); throw error; }
  return {
    has: name => entries.has(name),
    close: () => zip.close(),
    async *rows(name) {
      if (!entries.has(name)) return;
      const stream = await new Promise((resolve,reject) => zip.openReadStream(entries.get(name),(error,s) => error ? reject(error) : resolve(s)));
      let headersSeen = false;
      const parser = parse({ bom:true, skip_empty_lines:true, max_record_size:limits.recordBytes,
        columns: headers => {
          headersSeen = true;
          if (new Set(headers).size !== headers.length) throw new GtfsError(`Duplicate column in ${name}.`);
          for (const column of COLUMNS[name]) if (!headers.includes(column)) throw new GtfsError(`Missing ${column} header in ${name}.`);
          return headers;
        },
      });
      stream.on('error',error => parser.destroy(error));
      stream.pipe(parser);
      try {
        for await (const row of parser) yield validateRow(name,row);
        if (!headersSeen) throw new GtfsError(`Empty ${name}.`);
      } finally { stream.destroy(); parser.destroy(); }
    },
  };
}
