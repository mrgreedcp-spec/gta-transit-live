# Official transit evidence and fare model

Verified on **2026-11-23**, using official TTC, City of Mississauga, City of Toronto and Metrolinx sources. This date describes research verification. It is not a GTFS download timestamp or a guarantee of continuing accuracy. Re-check before updating prices or expanding calculator coverage.

## Adult single-journey prices used by the MVP

| Operator | PRESTO card / digital PRESTO | Contactless debit / credit | Cash |
| --- | ---: | ---: | ---: |
| TTC | CAD 3.30 | CAD 3.30 | CAD 3.35 |
| MiWay | CAD 3.50 | CAD 4.50 | CAD 4.50 |
| GO Transit | Official trip quote required | Official trip quote required | Unsupported in this calculator |

- TTC fare table: <https://www.ttc.ca/Fares-and-passes>
- MiWay fare table: <https://www.mississauga.ca/miway-transit/fares/fare-prices/>
- GO fare calculation: <https://www.gotransit.com/en/ways-to-pay/fare-information>

MiWay debit/credit contactless uses the cash fare, not the lower PRESTO card fare. GO fares depend on the specified origin, destination and fare type. The calculator accepts an adult official GO quote explicitly entered by the user, never a generated or default GO amount.

## One Fare rules and scope

Sources:

- <https://www.ttc.ca/Fares-and-passes/Regional-travel-and-One-Fare>
- <https://www.mississauga.ca/miway-transit/fares/transfers/>
- <https://www.gotransit.com/en/your-commute-to-go/go-transit-local-transit-partners>

For a supported adult journey, the same PRESTO card or the same debit/credit card or device must be used throughout. A physical credit card and that card inside a phone wallet must not be treated as interchangeable payment identities. One Fare excludes cash, PRESTO Tickets and GO e-tickets. GO bus riders must always tap on and off. Only GO train trips can use the applicable default-trip exception; default trips do not apply to buses. The official explanation is <https://www.gotransit.com/en/ways-to-pay/many-ways-to-pay-using-presto/set-a-default-trip-to-save-time>.

TTC / MiWay local-to-local transfers within two hours retain the first operator's fare. Local-to-GO transfers must occur within the local two-hour window; the local fare is reimbursed. GO-to-local transfers have a three-hour window from the GO tap. The TTC page also describes a new three-hour GO window after transferring from TTC to GO. The calculator handles only a single journey with at most two different operators, so it does not model the subsequent third leg.

The model conservatively regards exactly 120 minutes (local-first) or 180 minutes (GO-first) as expired. Official wording says "within" these periods and does not warrant reader-clock precision at the boundary. The interface must communicate this assumption.

For GO journeys the cost breakdown allocates the discount to the local leg, so the net local amount is zero and the GO amount remains the quoted GO fare. It represents final cost allocation, not the order of taps or refunds on a card statement. It never creates negative charges when the GO quote is smaller than the local fare.

### Deliberate limitations

The calculator covers adult, single journeys, with one payment method and at most two different operators. It does not model concession fares, passes, special purpose tickets, PRESTO Tickets, GO e-tickets, route-specific cash transfer exceptions, multiple GO segments, TTC fare caps, MiWay weekly loyalty or GO loyalty. Cash across TTC and MiWay is shown as separate single fares; the special TTC 52 Lawrence paper-transfer exception is outside this generic model. Unknown or invalid inputs return no payable total.

TTC's current page states that 47 eligible paid rides in a calendar month trigger monthly fare capping. Most TTC monthly passes stopped being sold after 2026-08-31; adult 12-Month Passes and post-secondary monthly passes remain. MiWay grants free remaining travel after 11 paid PRESTO rides in a Monday-to-Sunday week; free transfers and GO co-fares do not count. Do not multiply single fares by monthly trips and present it as a final fare-capped total.

## Official GTFS registry

### MiWay

Publishing page: <https://www.mississauga.ca/miway-transit/developer-download/>

- Static: <https://www.miapp.ca/GTFS/google_transit.zip>
- Realtime vehicles: <https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb>
- Realtime trips: <https://www.miapp.ca/GTFS_RT/TripUpdate/TripUpdates.pb>
- Realtime alerts: <https://www.miapp.ca/gtfs_rt/Alerts/Alerts.pb>
- Published terms: <https://www5.mississauga.ca/research_catalogue/CityofMississauga_TermsofUse.pdf>

The developer page, feed links and full four-page terms document were reviewed. The HTTPS terms endpoint returned errors; the same public official path over HTTP succeeded: <http://www5.mississauga.ca/research_catalogue/CityofMississauga_TermsofUse.pdf> (200,246 bytes; SHA-256 `76e0c18b3d807639b0aa9df04df41a9bfc999bdad10762954a333bdd939cbce4`). The terms permit lawful dataset reuse, require passing along the terms or their URL when redistributing data without added restrictions, prohibit implied endorsement and unapproved logos, disclaim warranties, and contain liability / indemnity provisions. Credit is encouraged but not required for each use. Retain the official terms link and City of Mississauga / MiWay attribution. A different, older three-page PDF at `/file/COM/CityOfMississaugaTermsOfUse.pdf` contains a City of Toronto template error and is not the document used for this review.

### TTC

- Static publisher: <https://open.toronto.ca/dataset/ttc-routes-and-schedules/>
- Machine discovery: <https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules>
- Static resource observed: <https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/opendata_ttc_schedules.zip>
- That resource reported `last_modified = 2026-11-05T12:44:27`.
- Complete merged feed publisher: <https://open.toronto.ca/dataset/merged-gtfs-ttc-routes-and-schedules/>
- Alerts dataset: <https://open.toronto.ca/dataset/ttc-gtfs-realtime-gtfs-rt/>, linking <https://gtfsrt.ttc.ca>.
- Vehicle / arrival dataset: <https://open.toronto.ca/dataset/ttc-bustime-real-time-next-vehicle-arrival-nvas/>, linking <https://bustime.ttc.ca/gtfsrt>.

The TTC `ttc-gtfs-realtime-gtfs-rt` dataset describes service alerts and disruptions. It must not be mistaken for a complete vehicle-prediction feed. The BusTime dataset explicitly requires its matching revised SurfaceGTFS at <https://open.toronto.ca/dataset/surface-routes-and-schedules-for-bustime/>. Do not assume every trip ID in an arbitrary legacy TTC schedule feed joins to BusTime predictions.

Licence: <https://open.toronto.ca/open-data-licence/>. Required default attribution: **Contains information licensed under the Open Government Licence – Toronto.** Link the licence. The data licence grants no logo / trademark rights and no official endorsement.

### GO Transit

- Publisher and access/use agreement: <https://www.gotransit.com/en/partner-with-us/software-developers>
- Static feed: <https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip>
- Publisher update date observed: 2026-11-17.

The Metrolinx access/use agreement requires its specified data legend to be displayed and excludes Metrolinx trademarks from the licence. Read and reproduce the required legend from that source on the site's data-attribution page when GO data is used. Merely naming GO Transit textually for navigation is distinct from using its logo. This research did not verify a free, unauthenticated production GO realtime endpoint; keep it as a future adapter until access is configured and verified.

## Provenance and freshness

Maintain separate source URL, licence, attribution, publisher-updated timestamp, fetched-at timestamp, hash, successful import time, service validity dates, active feed version and realtime message timestamp. A newer fetch does not prove new or valid service data. Label schedule-derived times as **Scheduled**; label predictions as realtime only when actual prediction messages are fresh. A verification date on this document must never appear as a live-arrival timestamp.

## Route-guide fact checks

The finite journey catalog was checked against these official pages on 2026-11-23:

- MiWay 109: <https://www.mississauga.ca/wp-content/uploads/sites/6/2026/04/02081419/Route-109-Meadowvale-Express-April27-2026.pdf>. This is the route map currently linked by MiWay, effective 2026-04-27. It shows City Centre and Kipling; northbound is toward Meadowvale Town Centre, southbound toward Kipling.
- City Centre terminal: <https://www.mississauga.ca/miway-transit/locations/city-centre-transit-terminal/>. The location page lists route 109 and identifies the terminal next to Square One.
- Kipling bus terminal: <https://www.mississauga.ca/miway-transit/locations/kipling-transit-hub/>. MiWay / GO bus boarding is distinct from the neighbouring TTC station.
- Square One GO: <https://www.gotransit.com/en/find-a-station-or-stop/00132>. Its location at 210 Centre View Drive differs from MiWay City Centre, 200 Rathburn Road West.
- St George TTC interchange: <https://www.ttc.ca/subway-stations/st-george-station>. It connects Line 2 with Line 1; the southbound Line 1 direction is Finch via Union.
- TTC airport access: <https://www.ttc.ca/riding-the-ttc/Service-to-the-airport/Toronto-Pearson-International-Airport>. The 900 connects Pearson Terminals 1 / 3 and Kipling; subway service / alerts must be checked for the departure.
- Pearson UP boarding: <https://www.torontopearson.com/en/transportation-and-parking/up-express>. UP boards at Terminal 1.
- Terminal Link: <https://www.torontopearson.com/en/transportation-and-parking/terminal-link-train>. It links Terminals 1 / 3 free of charge; check notices and temporary shuttle arrangements. The page showed maintenance during 2026-11-23 through 2026-11-30 when reviewed, so the durable guide directs readers to notices instead of promising normal operation.

The Square One–Union guide does not assert a direct route 21 journey. GO's generic route 21 update establishes that most route 21 buses serve Union, but does not establish a particular Square One boarding or departure. The guide therefore uses the official planner with exact origin / destination and date, plus the independently verified MiWay 109 + TTC alternative. No fixed journey duration, departure time or platform is generated.
