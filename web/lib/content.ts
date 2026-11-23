export type Locale = 'en' | 'zh';
export type Localized = { en: string; zh: string };
export const tr = (value: Localized, locale: Locale) => value[locale];
export const REVIEW_DATE = '2026-11-23';
export const BRAND = 'GTA Transit Live';

// A reviewed, finite catalog. GTFS imports never create indexable pages automatically.
export const PAGE_PATHS = [
  '', 'fare-calculator', 'one-fare', 'operators', 'operators/ttc',
  'operators/miway', 'operators/go-transit', 'routes',
  'routes/square-one-to-union-station', 'routes/pearson-to-union-station',
  'routes/kipling-to-square-one', 'sources', 'privacy',
] as const;
export type PagePath = typeof PAGE_PATHS[number];
export function pageUrl(path: string, locale: Locale): string {
  return `${locale === 'zh' ? '/zh' : ''}${path ? `/${path}` : ''}` || '/';
}
export function isPagePath(path: string): path is PagePath {
  return (PAGE_PATHS as readonly string[]).includes(path);
}
export const SOURCES = {
  ttcFares: { title: 'TTC — Fares and passes', url: 'https://www.ttc.ca/Fares-and-passes' },
  oneFare: { title: 'TTC — Regional travel and One Fare', url: 'https://www.ttc.ca/Fares-and-passes/Regional-travel-and-One-Fare' },
  miwayFares: { title: 'MiWay — Fare prices', url: 'https://www.mississauga.ca/miway-transit/fares/fare-prices/' },
  miwayTransfers: { title: 'MiWay — Transfers', url: 'https://www.mississauga.ca/miway-transit/fares/transfers/' },
  goFares: { title: 'GO Transit — Fare information', url: 'https://www.gotransit.com/en/ways-to-pay/fare-information' },
  goPartners: { title: 'GO Transit — Local transit partners', url: 'https://www.gotransit.com/en/your-commute-to-go/go-transit-local-transit-partners' },
  goDefaultTrip: { title: 'GO Transit — Default trips apply to trains only', url: 'https://www.gotransit.com/en/ways-to-pay/many-ways-to-pay-using-presto/set-a-default-trip-to-save-time' },
  goPlanner: { title: 'GO Transit — Official trip planner', url: 'https://www.gotransit.com/en/plan-your-trip' },
  squareOneGo: { title: 'GO Transit — Square One stop details', url: 'https://www.gotransit.com/en/find-a-station-or-stop/00132' },
  ttcData: { title: 'City of Toronto — TTC schedules', url: 'https://open.toronto.ca/dataset/ttc-routes-and-schedules/' },
  ttcRealtime: { title: 'City of Toronto — TTC BusTime real-time arrivals', url: 'https://open.toronto.ca/dataset/ttc-bustime-real-time-next-vehicle-arrival-nvas/' },
  miwayData: { title: 'MiWay — Developer download', url: 'https://www.mississauga.ca/miway-transit/developer-download/' },
  goData: { title: 'GO Transit — Software developers', url: 'https://www.gotransit.com/en/partner-with-us/software-developers' },
  kipling: { title: 'MiWay — Kipling Bus Terminal', url: 'https://www.mississauga.ca/miway-transit/locations/kipling-transit-hub/' },
  cityCentre: { title: 'MiWay — City Centre Transit Terminal', url: 'https://www.mississauga.ca/miway-transit/locations/city-centre-transit-terminal/' },
  miway109: { title: 'MiWay — Route 109 map, effective April 27, 2026', url: 'https://www.mississauga.ca/wp-content/uploads/sites/6/2026/04/02081419/Route-109-Meadowvale-Express-April27-2026.pdf' },
  stGeorge: { title: 'TTC — St George Station interchange and directions', url: 'https://www.ttc.ca/subway-stations/st-george-station' },
  pearsonUp: { title: 'Pearson Airport — Where to board UP Express', url: 'https://www.torontopearson.com/en/transportation-and-parking/up-express' },
  terminalLink: { title: 'Pearson Airport — Terminal Link train and service notices', url: 'https://www.torontopearson.com/en/transportation-and-parking/terminal-link-train' },
  up: { title: 'UP Express — Pearson Station departures', url: 'https://www.upexpress.com/en/up-express-stations/pearson-station/departures-and-schedules' },
  upFares: { title: 'UP Express — Tickets and fares', url: 'https://www.upexpress.com/en/ways-to-pay/up-express-fares' },
  ttcAirport: { title: 'TTC — Toronto Pearson International Airport', url: 'https://www.ttc.ca/riding-the-ttc/Service-to-the-airport/Toronto-Pearson-International-Airport' },
} as const;
export type SourceKey = keyof typeof SOURCES;

export const pageMeta: Record<PagePath, { title: Localized; description: Localized }> = {
  '': {
    title: { en: 'GTA transit guide, fares & connections', zh: '大多伦多公交指南、票价与换乘' },
    description: { en: 'Plan a clearer journey across Toronto and Mississauga. Compare TTC and MiWay fares, understand Ontario One Fare, and open the GTA Transit Live map.', zh: '查询 TTC、MiWay 和 GO 的乘车指南，比较成人票价，了解 Ontario One Fare 换乘规则，并打开 GTA 公交实时地图。' },
  },
  'fare-calculator': {
    title: { en: 'GTA fare calculator — TTC, MiWay & GO transfers', zh: 'GTA 公交票价计算器：TTC、MiWay 与 GO 换乘' },
    description: { en: 'Estimate adult TTC and MiWay fares with PRESTO, debit, credit or cash. Check One Fare transfer windows. GO journeys require your official fare quote.', zh: '按 PRESTO、银行卡或现金比较 TTC 和 MiWay 成人单程票价，检查 One Fare 换乘时限。含 GO 的行程需输入官方票价。' },
  },
  'one-fare': {
    title: { en: 'Ontario One Fare guide — transfer windows & eligibility', zh: 'Ontario One Fare 指南：换乘时限与适用条件' },
    description: { en: 'Understand two-hour local transfers, three-hour GO connections, same-card rules and exclusions with links to official Ontario One Fare guidance.', zh: '了解本地公交两小时和 GO 三小时换乘时限、同卡同设备规则及不适用情况，附官方来源。' },
  },
  operators: {
    title: { en: 'TTC, MiWay & GO Transit — choose your operator', zh: 'TTC、MiWay 与 GO Transit：交通机构指南' },
    description: { en: 'Find the right TTC, MiWay and GO Transit guide for fares, payments, official schedules and connections across the Greater Toronto Area.', zh: '查看 TTC、MiWay 与 GO 的票价、付款、官方时刻表和跨市换乘信息。' },
  },
  'operators/ttc': {
    title: { en: 'TTC guide — adult fares, payments & regional transfers', zh: 'TTC 乘车指南：成人票价、付款与跨市换乘' },
    description: { en: 'TTC adult PRESTO and contactless fares, cash payments, two-hour transfers and connections to MiWay and GO, with official sources.', zh: '了解 TTC 成人 PRESTO、银行卡与现金票价，两小时换乘，以及前往 MiWay 和 GO 的衔接。' },
  },
  'operators/miway': {
    title: { en: 'MiWay guide — Mississauga fares & TTC connections', zh: 'MiWay 乘车指南：密西沙加票价与 TTC 换乘' },
    description: { en: 'Compare MiWay PRESTO and contactless fares, find official Mississauga schedules and understand connections at Kipling and City Centre.', zh: '比较 MiWay 的 PRESTO 与银行卡票价，查询密西沙加官方时刻表，了解 Kipling 和市中心交通枢纽。' },
  },
  'operators/go-transit': {
    title: { en: 'GO Transit guide — distance fares, tap off & One Fare', zh: 'GO Transit 指南：里程票价、下车刷卡与 One Fare' },
    description: { en: 'Understand GO train and bus fares, get an official trip quote, check tap-on and tap-off requirements, and connect with TTC or MiWay.', zh: '了解 GO 火车和巴士的里程票价、官方行程报价、上下车刷卡要求及 TTC、MiWay 换乘。' },
  },
  routes: {
    title: { en: 'GTA journey guides — Square One, Kipling, Pearson & Union', zh: 'GTA 路线指南：Square One、Kipling、Pearson 与 Union' },
    description: { en: 'Reviewed, source-linked journey guides for Mississauga, downtown Toronto and Pearson Airport. Check official departure information before travel.', zh: '查看密西沙加、多伦多市中心和皮尔逊机场的出行指南，含官方线路及出发前核对事项。' },
  },
  'routes/square-one-to-union-station': {
    title: { en: 'Square One to Union Station — transit options & fare planning', zh: 'Square One 到 Union Station：公交选择与票价规划' },
    description: { en: 'Compare GO journey planning with a MiWay–TTC connection from Square One to Union Station. Know the terminal difference and avoid guessed departure times.', zh: '比较 Square One 到 Union 的 GO 方案与 MiWay–TTC 衔接，分清两个交通枢纽，查询官方班次。' },
  },
  'routes/pearson-to-union-station': {
    title: { en: 'Pearson Airport to Union Station — UP Express & TTC options', zh: '皮尔逊机场到 Union Station：UP Express 与 TTC 方案' },
    description: { en: 'Choose between UP Express and a TTC airport connection. Check Terminal 1 access, official ticket prices and the separate UP Express fare rules.', zh: '比较 UP Express 与 TTC 机场衔接，了解一号航站楼上车、官方票价及 UP Express 独立收费规则。' },
  },
  'routes/kipling-to-square-one': {
    title: { en: 'Kipling to Square One — MiWay 109 & transfer guide', zh: 'Kipling 到 Square One：MiWay 109 与换乘指南' },
    description: { en: 'Use MiWay 109 between Kipling Bus Terminal and City Centre Transit Terminal. Check the direction, platform, payment method and One Fare eligibility.', zh: '了解 Kipling 与 City Centre Transit Terminal 之间的 MiWay 109，核对方向、站台、付款与 One Fare。' },
  },
  sources: {
    title: { en: 'Data sources, freshness & transit attribution', zh: '数据来源、更新时间与署名' },
    description: { en: 'See the official TTC, MiWay and GO sources behind this independent guide, how scheduled and real-time data differ, and our update and attribution policy.', zh: '查看本站采用的 TTC、MiWay 与 GO 官方来源，区分计划时刻和实时预测，了解数据更新与署名。' },
  },
  privacy: {
    title: { en: 'Privacy & independent project information', zh: '隐私与独立项目信息' },
    description: { en: 'How the public fare calculator handles your inputs and how the existing signed-in live map uses account, favourites and notification data.', zh: '了解公开票价计算器如何处理输入，以及需登录的实时地图如何使用账号、收藏和通知数据。' },
  },
};

export const operators = [
  {
    id: 'ttc', name: 'TTC', color: '#c73943', tag: { en: 'TORONTO', zh: '多伦多' },
    summary: { en: 'Subway, streetcar and bus connections across Toronto.', zh: '连接多伦多各区的地铁、有轨电车与巴士。' },
    fare: '$3.30', fareLabel: { en: 'Adult · PRESTO / contactless', zh: '成人 · PRESTO / 银行卡' },
    intro: { en: 'Start with the TTC for travel within Toronto. The way you pay determines your transfer options; keep the same card or device for your whole journey.', zh: '在多伦多市内出行可先查看 TTC。付款方式决定换乘待遇；全程保持使用同一张卡或同一设备。' },
    sections: [
      { title: { en: 'Choose how to pay', zh: '选择付款方式' }, body: { en: 'An adult single fare is $3.30 with PRESTO or a debit/credit card, and $3.35 with cash. Discount fare types and passes follow separate rules. A physical bank card and the same card in your phone wallet are different payment credentials.', zh: '成人单程使用 PRESTO 或借记卡／信用卡为 $3.30，现金为 $3.35。优惠票种与通票另有规则。实体银行卡与手机钱包中的同一银行卡属于不同付款凭证。' } },
      { title: { en: 'Keep your transfer window', zh: '留意换乘时间' }, body: { en: 'Eligible electronic payments open a two-hour transfer window. Continue tapping the same payment credential when boarding or entering a station. Cash and PRESTO Tickets do not qualify for cross-agency One Fare.', zh: '符合条件的电子付款开启两小时换乘时限。上车或进入车站时，继续刷同一付款凭证。现金和 PRESTO Ticket 不适用跨机构 One Fare。' } },
      { title: { en: 'Connecting beyond Toronto', zh: '前往多伦多以外地区' }, body: { en: 'An eligible connection to MiWay within the window does not add a second local fare. When connecting to GO, the TTC portion is reimbursed under One Fare; the GO fare still applies. Check the official page for passes, fare caps and special eligibility.', zh: '在有效期内按规则换乘 MiWay，无需额外支付第二次本地公交费。换乘 GO 时，One Fare 可退回 TTC 部分，但 GO 票价仍需支付。通票、封顶和特殊资格请查官方规则。' } },
    ], sources: ['ttcFares', 'oneFare'] as SourceKey[], officialUrl: 'https://www.ttc.ca/routes-and-schedules',
  },
  {
    id: 'miway', name: 'MiWay', color: '#c55512', tag: { en: 'MISSISSAUGA', zh: '密西沙加' },
    summary: { en: 'Local and express buses around Mississauga and the Transitway.', zh: '密西沙加本地巴士、快速巴士与 Transitway。' },
    fare: '$3.50', fareLabel: { en: 'Adult · PRESTO', zh: '成人 · PRESTO' },
    intro: { en: 'MiWay links Mississauga neighbourhoods with City Centre, Kipling and GO services. PRESTO and bank-card payments have different adult prices, even though both can qualify for One Fare.', zh: 'MiWay 连接密西沙加社区、市中心、Kipling 与 GO。PRESTO 和银行卡虽均可符合 One Fare 条件，成人票价却不同。' },
    sections: [
      { title: { en: 'PRESTO and contactless cost different amounts', zh: 'PRESTO 与银行卡收费不同' }, body: { en: 'The adult PRESTO fare is $3.50. A contactless debit/credit card or exact cash costs $4.50. This guide calculates those payment methods separately. The driver cannot provide change for cash.', zh: '成人 PRESTO 为 $3.50；借记卡／信用卡感应支付或足额现金为 $4.50。计算器分别处理这几种方式。司机不提供现金找零。' } },
      { title: { en: 'Know the two City Centre terminals', zh: '分清市中心的两个枢纽' }, body: { en: 'City Centre Transit Terminal serves MiWay. Square One GO Terminal serves GO. Treat them as distinct boarding locations and confirm the operator and platform in the official journey planner before leaving.', zh: 'City Centre Transit Terminal 供 MiWay 使用，Square One GO Terminal 供 GO 使用。它们是不同的上车地点，请出发前在官方规划器确认运营商和站台。' } },
      { title: { en: 'Frequent travel needs a separate comparison', zh: '高频通勤需另行比较' }, body: { en: 'MiWay lists a $145 adult PRESTO monthly pass and a weekly loyalty program: after 11 paid PRESTO rides from Monday to Sunday, remaining rides that week are free. Transfers and discounted GO co-fare rides do not add a paid ride. The calculator estimates one journey only.', zh: 'MiWay 成人 PRESTO 月票为 $145；周一至周日付费乘坐 11 次后，当周余下乘车免费。换乘和优惠 GO 接驳不计额外付费次数。本站计算器仅估算一次行程。' } },
    ], sources: ['miwayFares', 'miwayTransfers', 'cityCentre', 'squareOneGo', 'kipling'] as SourceKey[], officialUrl: 'https://www.mississauga.ca/miway-transit/schedules/',
  },
  {
    id: 'go-transit', name: 'GO Transit', color: '#287d49', tag: { en: 'ACROSS THE REGION', zh: '跨城市出行' },
    summary: { en: 'Regional trains and buses connecting communities across the GTA.', zh: '连接大多伦多地区各社区的区域火车与巴士。' },
    fare: null, fareLabel: { en: 'Fare varies by journey', zh: '按具体行程计价' },
    intro: { en: 'GO journeys are priced by origin, destination and fare type. Use the official GO fare tool for your trip; this website never substitutes a made-up flat fare.', zh: 'GO 按起点、终点和票种收费。请使用官方工具查询具体行程票价，本站不提供虚构的统一价格。' },
    sections: [
      { title: { en: 'Get an official fare first', zh: '先获取官方票价' }, body: { en: 'Use GO’s official trip and fare information for the stations or bus stops you will actually use. Enter that quoted adult fare in our calculator to examine a TTC or MiWay connection. The entered quote is yours; it is not an automatic live price feed.', zh: '使用 GO 官方行程和票价工具查询实际上下车站。将获得的成人报价输入本站计算器，即可查看 TTC 或 MiWay 衔接。该报价由你输入，并非自动实时价格源。' } },
      { title: { en: 'Tap on and tap off', zh: '上车、下车均需刷卡' }, body: { en: 'Tap on and off every GO bus journey with the same card or device. On GO trains, an applicable default trip can remove the need to tap off; default trips do not apply to buses. Keep the same payment credential for local connections. One Fare excludes GO e-tickets and cash.', zh: '每次搭 GO 巴士，上下车均须刷同一张卡或设备。GO 火车适用已设置的默认行程时可免刷下车卡；默认行程不适用于巴士。本地公交衔接也须保持同一付款凭证。GO 电子车票及现金不适用 One Fare。' } },
      { title: { en: 'The order of your journey matters', zh: '乘车顺序影响时限' }, body: { en: 'Starting on GO gives eligible local connections a three-hour window from the first GO tap. Starting on TTC or MiWay means reaching GO within the local two-hour window. The local component can then be waived or reimbursed; GO remains payable.', zh: '先乘 GO，符合条件的本地换乘时限从首次 GO 刷卡起算三小时。先乘 TTC 或 MiWay，则需在本地两小时有效期内换乘 GO。本地部分可免收或退回，但 GO 仍需付费。' } },
    ], sources: ['goFares', 'goPartners', 'goDefaultTrip', 'oneFare'] as SourceKey[], officialUrl: 'https://www.gotransit.com/en/plan-your-trip',
  },
];

export const journeys = [
  {
    slug: 'square-one-to-union-station', origin: 'Square One', destination: 'Union Station', badge: 'MiWay · TTC · GO',
    area: { en: 'MISSISSAUGA TO TORONTO', zh: '密西沙加至多伦多' },
    description: { en: 'Compare a regional journey with a local-transit connection.', zh: '比较区域公交与本地公交衔接方案。' },
    intro: { en: 'There are several ways to make this journey, and the right one depends on when you leave. Start with the correct boarding terminal and compare the official GO planner with a MiWay–TTC connection.', zh: '这段行程有不同方案，适合哪一种取决于出发时间。先确认上车枢纽，再比较官方 GO 规划与 MiWay–TTC 衔接。' },
    steps: [
      { title: { en: 'Choose the right starting terminal', zh: '选对出发枢纽' }, body: { en: 'For MiWay, use City Centre Transit Terminal; for GO, select Square One GO Terminal. Do not assume a GO departure leaves from a MiWay platform.', zh: '搭 MiWay 选择 City Centre Transit Terminal；搭 GO 选择 Square One GO Terminal。不要把 GO 班次的上车点理解为 MiWay 站台。' } },
      { title: { en: 'Compare GO with MiWay and TTC', zh: '比较 GO 与 MiWay、TTC 组合' }, body: { en: 'For a GO-based journey, enter Square One and Union Station in GO’s planner for your departure date and time, then check the complete itinerary and any transfers. For a local-transit option, take MiWay 109 southbound toward Kipling, then TTC Line 2 eastbound to St George and Line 1 southbound (Finch via Union) to Union.', zh: '在 GO 规划器输入 Square One、Union Station 及出发日期时间，核对完整行程与所需换乘。本地公交方案可乘 MiWay 109 南行往 Kipling，再换 TTC 2 号线向东至 St George，转 1 号线南行（经 Union 往 Finch）到 Union 下车。' } },
      { title: { en: 'Price the journey in its actual order', zh: '按实际乘车顺序计算费用' }, body: { en: 'Starting with MiWay sets the initial local fare. An eligible TTC connection inside the two-hour window adds no TTC fare. If you use GO, obtain its official trip price first. A guide is not a live timetable: confirm departures and service alerts before travelling.', zh: '先乘 MiWay 则以 MiWay 为首段票价；两小时内符合条件换乘 TTC，不再加收 TTC 费用。使用 GO 则需先查询官方报价。指南并非实时刻表，请出行前核对班次和服务通知。' } },
    ],
    watch: { en: 'Check the complete GO itinerary for your departure, including any transfers, and confirm the boarding stop. The MiWay–TTC option also depends on that day’s service and subway alerts.', zh: '按实际出发时间查询完整 GO 行程，包括所需换乘，并确认上车站。MiWay–TTC 方案也需核对当天班次与地铁服务通知。' },
    planner: 'https://www.gotransit.com/en/plan-your-trip', sources: ['goPlanner', 'squareOneGo', 'cityCentre', 'kipling', 'miway109', 'stGeorge', 'oneFare'] as SourceKey[],
  },
  {
    slug: 'pearson-to-union-station', origin: 'Pearson Airport', destination: 'Union Station', badge: 'UP Express · TTC',
    area: { en: 'AIRPORT TO DOWNTOWN', zh: '机场至市中心' },
    description: { en: 'Find your airport connection and check which fare applies.', zh: '选择机场接驳，并核对对应收费规则。' },
    intro: { en: 'UP Express connects Pearson Airport with Union Station. TTC also offers airport bus connections to the subway. Choose based on your terminal, luggage and the official departures available when you land.', zh: 'UP Express 连接皮尔逊机场与 Union。TTC 也提供机场巴士连接地铁。可根据航站楼、行李和到达时的实际班次选择。' },
    steps: [
      { title: { en: 'Find the airport boarding point', zh: '确认机场上车地点' }, body: { en: 'UP Express boards at Pearson Terminal 1, next to Terminal Link. From Terminal 3, take the free Terminal Link to Terminal 1 and follow the Train to City signs. Check airport service notices and use a replacement shuttle if directed during maintenance.', zh: 'UP Express 车站位于皮尔逊一号航站楼、Terminal Link 旁。从三号航站楼搭免费 Terminal Link 到一号航站楼，再按 Train to City 标识前往。请查看机场服务通知，检修期间如有指示则搭替代接驳巴士。' } },
      { title: { en: 'Compare the TTC alternative', zh: '比较 TTC 备选方案' }, body: { en: 'The TTC 900 Airport Express connects Pearson with Kipling. For Union, continue on Line 2 eastbound to St George, then Line 1 southbound (Finch via Union) to Union. Check TTC’s airport page for the correct terminal stop and current service.', zh: 'TTC 900 Airport Express 连接机场与 Kipling。前往 Union 可继续搭 2 号线向东至 St George，再换 1 号线南行（经 Union 往 Finch）到 Union 下车。请查 TTC 机场页面确认航站楼停靠点及当日服务。' } },
      { title: { en: 'Check the correct ticket rules', zh: '核对正确票种规则' }, body: { en: 'UP Express has its own fares and is outside this calculator’s TTC–MiWay–GO scope. Do not treat an UP ticket as a GO fare or apply a One Fare discount automatically. Use UP’s official fares page for your group and payment method.', zh: 'UP Express 有独立票价，不在本计算器的 TTC–MiWay–GO 范围内。不要把 UP 车票当成 GO 票价，也不要自动套用 One Fare 折扣。请在 UP 官方页面按人数和付款方式查询。' } },
    ],
    watch: { en: 'UP Express and GO Transit are distinct services with different ticket rules. This page does not promise a fixed travel time or a live departure.', zh: 'UP Express 与 GO Transit 的服务和车票规则不同。本页不保证固定行车时间，也不提供实时发车预测。' },
    planner: 'https://www.upexpress.com/en/up-express-stations/pearson-station/departures-and-schedules', sources: ['up', 'upFares', 'pearsonUp', 'terminalLink', 'ttcAirport', 'stGeorge'] as SourceKey[],
  },
  {
    slug: 'kipling-to-square-one', origin: 'Kipling', destination: 'Square One', badge: 'MiWay 109 · TTC connection',
    area: { en: 'TORONTO TO MISSISSAUGA', zh: '多伦多至密西沙加' },
    description: { en: 'A practical guide to MiWay 109 and your TTC transfer.', zh: 'MiWay 109 与 TTC 换乘的实用指南。' },
    intro: { en: 'MiWay 109 Meadowvale Express serves both Kipling Bus Terminal and City Centre Transit Terminal, next to Square One. A TTC-to-MiWay connection can qualify for One Fare when your payment and timing meet the rules.', zh: 'MiWay 109 Meadowvale Express 停靠 Kipling Bus Terminal 和 Square One 旁的 City Centre Transit Terminal。符合付款和时间规则时，TTC 转 MiWay 可享 One Fare。' },
    steps: [
      { title: { en: 'Use the MiWay bus terminal', zh: '前往 MiWay 巴士枢纽' }, body: { en: 'At Kipling, follow signs to the MiWay / GO bus terminal. TTC, MiWay and GO share the broader hub but have distinct boarding areas. Use the official terminal map to locate the current 109 stop.', zh: '在 Kipling 按标识前往 MiWay／GO 巴士枢纽。TTC、MiWay 和 GO 同属这个交通枢纽，但上车区域不同。请按官方枢纽图寻找当前 109 站点。' } },
      { title: { en: 'Check the direction and stop', zh: '核对方向和下车站' }, body: { en: 'Look for route 109 toward Meadowvale and confirm City Centre Transit Terminal appears in the stop list. Get off at City Centre for Square One. Platforms and detours can change, so recheck the departure display.', zh: '寻找 109 路往 Meadowvale 方向，并确认停站列表含 City Centre Transit Terminal。前往 Square One 可在 City Centre 下车。站台和绕行可能变化，请核对现场显示。' } },
      { title: { en: 'Keep the same payment credential', zh: '保持同一付款凭证' }, body: { en: 'If you started on TTC less than two hours earlier, tap the same eligible PRESTO or bank card/device on MiWay for the transfer. If starting your journey at Kipling on MiWay, pay MiWay’s own fare: $3.50 PRESTO or $4.50 contactless/cash for an adult.', zh: '如首次 TTC 刷卡距今不足两小时，请在 MiWay 使用同一张符合条件的 PRESTO、银行卡或同一设备换乘。若从 Kipling 首次搭 MiWay，则成人 PRESTO 为 $3.50，银行卡／现金为 $4.50。' } },
    ],
    watch: { en: 'Your transfer clock starts at the first paid tap, not when you arrive at Kipling. Switching between a bank card and phone wallet can trigger another fare.', zh: '换乘计时从首次付费刷卡开始，并非到达 Kipling 才开始。实体银行卡与手机钱包切换使用可能产生第二次收费。' },
    planner: 'https://www.mississauga.ca/miway-transit/schedules/', sources: ['kipling', 'cityCentre', 'miway109', 'miwayFares', 'oneFare'] as SourceKey[],
  },
];
