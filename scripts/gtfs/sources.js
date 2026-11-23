// Reviewed official distribution endpoints, 2026-11-23. No caller-supplied URL.
// This importer is independent of the existing live-map cache and credentials.
export const SOURCES = Object.freeze({
  ttc: {
    name: 'TTC',
    url: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip',
    page: 'https://open.toronto.ca/dataset/surface-routes-and-schedules-for-bustime/',
    license: 'https://open.toronto.ca/open-data-licence/',
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
    note: 'SurfaceGTFS is the published static companion for TTC BusTime predictions; it does not claim complete subway coverage.',
  },
  miway: {
    name: 'MiWay',
    url: 'https://www.miapp.ca/GTFS/google_transit.zip',
    page: 'https://www.mississauga.ca/miway-transit/developer-download/',
    license: 'https://www.mississauga.ca/miway-transit/developer-download/',
    attribution: 'MiWay schedule data supplied by the City of Mississauga. This is an independent, unofficial service.',
  },
  go: {
    name: 'GO Transit',
    url: 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip',
    page: 'https://www.gotransit.com/en/partner-with-us/software-developers',
    license: 'https://www.gotransit.com/en/partner-with-us/software-developers',
    attribution: 'Data used in this product or service is provided with the permission of Metrolinx. Metrolinx makes no representations or warranties of any kind, express or implied, with respect to the Data and assumes no responsibility for the accuracy or currency of the data used in this product or service.',
    note: 'Check the linked Metrolinx terms before use. GO real-time API requires separate registration; this importer does not redistribute it.',
  },
});

export function sourceFor(agency) {
  if (!Object.hasOwn(SOURCES, agency)) throw new Error('Unsupported agency; choose ttc, miway or go.');
  return SOURCES[agency];
}
