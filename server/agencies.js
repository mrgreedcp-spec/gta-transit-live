// 机构配置表。enabled=false 可关掉某个源。
import { goKey } from './go.js';
const GO_KEY = goKey();

export const AGENCIES = [
  {
    id: 'ttc', name: 'TTC', color: '#da251d', enabled: true,
    staticUrl: 'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip',
    vehiclesUrl: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    tripUpdatesUrl: 'https://bustime.ttc.ca/gtfsrt/trips',
    note: '实时源 bustime.ttc.ca 可能有地区限制，在加拿大网络下可用。',
  },
  {
    id: 'go', name: 'GO Transit', color: '#3d8c2f', enabled: true,
    staticUrl: 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip',
    // GO 实时走 OpenDataAPI 的 JSON 接口（server/go.js），不走通用 GTFS-RT 流程。
    goApi: true, requiresKey: true, hasKey: !!GO_KEY,
    note: GO_KEY ? '' : '实时需 GO_API_KEY（免费）。申请：https://api.openmetrolinx.com/OpenDataAPI/Help/Registration/en',
  },
  {
    id: 'miway', name: 'MiWay', color: '#f39200', enabled: true,
    staticUrl: 'https://www.miapp.ca/GTFS/google_transit.zip',
    vehiclesUrl: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    tripUpdatesUrl: 'https://www.miapp.ca/GTFS_RT/TripUpdate/TripUpdates.pb',
  },
  {
    id: 'brampton', name: 'Brampton Transit', color: '#0072bc', enabled: true,
    staticUrl: 'https://www.arcgis.com/sharing/rest/content/items/a355aabd5a8c490186bdce559c9c75fb/data',
    vehiclesUrl: 'https://gtfs-rt-merge.prod.bt-cadavl.com/BramptonTransit/GTFS/merged_VehiclePosition.pb',
    tripUpdatesUrl: 'https://gtfs-rt-merge.prod.bt-cadavl.com/BramptonTransit/GTFS/merged_TripUpdate.pb',
  },
  {
    id: 'yrt', name: 'YRT', color: '#7b2d8e', enabled: true,
    staticUrl: 'https://www.yrt.ca/google/google_transit.zip',
    vehiclesUrl: 'http://rtu.york.ca/gtfsrealtime/VehiclePositions',
    tripUpdatesUrl: 'http://rtu.york.ca/gtfsrealtime/TripUpdates',
    note: 'YRT 官方要求先在 yrt.ca 填表接受数据许可。',
  },
  {
    id: 'durham', name: 'Durham (DRT)', color: '#00838f', enabled: true,
    staticUrl: 'https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip',
    vehiclesUrl: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    tripUpdatesUrl: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates',
  },
];

export const byId = Object.fromEntries(AGENCIES.map(a => [a.id, a]));
