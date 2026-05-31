-- #488 — Populate terminal_addresses, parking_info, transit_dropoff_info,
-- arrival_advice for the 17 North American departure ports seeded in
-- 20260602000000_email_notifications.sql.
--
-- Content sourced from public port-authority documentation and is current as
-- of the build date. Official port URLs (stored in official_url) are the
-- authoritative source for pricing and terminal assignments, which change
-- seasonally. This migration sets the last-known content; re-run with a new
-- migration when details change.
--
-- terminal_addresses schema: [{ "terminal": "<name>", "address": "<full>" }]

-- ── Miami (MIA) ───────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Terminal A",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal B",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal C",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal D",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal E",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal F",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal G",  "address": "1015 N America Way, Miami, FL 33132"},
    {"terminal": "Terminal J",  "address": "1015 N America Way, Miami, FL 33132"}
  ]'::jsonb,
  parking_info = 'Multiple covered garages on port grounds (Garages 1–4). Current daily rates are posted at miamidade.gov/portmiami — expect $20–25/day for a 7-night cruise. Book online in advance for best rates; garages fill quickly on peak sailings. Long-term lot available for extended voyages.',
  transit_dropoff_info = 'Rideshare/taxi: use the Port of Miami Tunnel (I-395 east → tunnel) for direct port access without downtown surface traffic. Designated ride-share and taxi drop-off zones are at each terminal entrance. From Miami International Airport (MIA): ~20 min by rideshare. No direct Metrorail connection; Metromover reaches Park West Station (~1 mile walk).',
  arrival_advice = 'Allow 3+ hours before departure; the I-395 approach can back up 45+ minutes on peak days. PortMiami is a busy multi-terminal campus — confirm your terminal letter from your cruise line before arriving; the wrong terminal can add 20 minutes of walking. Early check-in windows (when offered) are worth booking.'
WHERE port_code = 'MIA';

-- ── Port Canaveral (PCV) ──────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Terminal 1", "address": "9155 Astronaut Blvd, Cape Canaveral, FL 32920"},
    {"terminal": "Terminal 3", "address": "9150 Discovery Rd, Cape Canaveral, FL 32920"},
    {"terminal": "Terminal 5", "address": "9245 Charles M Rowland Dr, Cape Canaveral, FL 32920"},
    {"terminal": "Terminal 8", "address": "9490 Discovery Rd, Cape Canaveral, FL 32920"},
    {"terminal": "Terminal 10", "address": "9005 Charles M Rowland Dr, Cape Canaveral, FL 32920"}
  ]'::jsonb,
  parking_info = 'Port Canaveral offers both surface lots and multi-story garages adjacent to the cruise terminals. Book through portcanaveral.com for guaranteed pre-paid pricing. Garages are a short walk from terminals; porter service is available at the terminal curb for luggage.',
  transit_dropoff_info = 'No direct public transit from Orlando International Airport (MCO). Rideshare and shuttle services (GoPort, Cocoa Beach Shuttle) are the primary options — roughly 45–60 min from MCO. Designated drop-off lanes are clearly marked at each terminal. Cruise line–operated bus transfers from MCO and select hotels are often available.',
  arrival_advice = 'Confirm your terminal number from your cruise line before departure — terminals are spread along Discovery Rd and Charles M. Rowland Dr with significant distance between them. Arrive 2.5–3 hours before sailing. SR-528 (Beachline Expressway) is the main approach; traffic is light compared to larger ports.'
WHERE port_code = 'PCV';

-- ── Galveston (GAL) ───────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Cruise Terminal 1", "address": "2702 Harborside Dr, Galveston, TX 77550"},
    {"terminal": "Cruise Terminal 2", "address": "5 Ave A, Galveston, TX 77550"}
  ]'::jsonb,
  parking_info = 'On-site surface parking is available at both terminals (lots managed by the Port of Galveston). Advance reservations are strongly recommended via portofgalveston.com; parking sells out for holiday sailings. Shuttle service from overflow lots runs continuously. Rates are posted on the port website.',
  transit_dropoff_info = 'Rideshare and taxis are the most practical option from Houston (IAH ~75 min, HOU ~60 min). Galveston Island Transit (The Wave) connects downtown Galveston to the port but does not serve Houston airports. Drop-off zones are at both terminal entrances. Cruise line bus transfers from Houston airports are widely available and recommended for convenience.',
  arrival_advice = 'Galveston causeway (I-45 South) is the sole road access to the island; expect significant backups on embarkation morning, especially on 3- and 4-day cruises with high turnover. Allow 3+ hours from Houston. The port is compact and well-staffed — once at the terminal, embarkation is typically smooth.'
WHERE port_code = 'GAL';

-- ── Seattle (SEA) ─────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Smith Cove Cruise Terminal (Pier 91)", "address": "2001 W Garfield St, Seattle, WA 98119"},
    {"terminal": "Bell Street Cruise Terminal (Pier 66)", "address": "2225 Alaskan Way, Seattle, WA 98121"}
  ]'::jsonb,
  parking_info = 'Pier 91: on-site parking garage adjacent to the terminal; book in advance through the Port of Seattle website. Pier 66: several private garages within walking distance on Alaskan Way and Western Ave; no dedicated terminal garage. Rates vary by terminal and season — confirm when booking.',
  transit_dropoff_info = 'Pier 91 (Smith Cove): accessible via D Line RapidRide bus to Dravus St, then rideshare; most guests use rideshare or shuttle directly to the terminal. Pier 66 (Bell Street): downtown location, convenient from SeaTac via Link Light Rail to Westlake Station (15 min walk) or rideshare. Designated drop-off loops are at both terminals.',
  arrival_advice = 'Seattle–Tacoma International Airport is approximately 30–45 min from the terminals by rideshare. Alaska cruises have fixed departure windows — the ship cannot wait for latecomers. Arrive at least 3 hours before sailing. Pier 91 is the more common Alaska embarkation terminal; verify with your cruise line.'
WHERE port_code = 'SEA';

-- ── Vancouver (YVR) ───────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Canada Place Cruise Ship Terminal", "address": "999 Canada Place, Vancouver, BC V6C 3T4"},
    {"terminal": "Ballantyne Cruise Terminal",        "address": "693 Commissioner St, Vancouver, BC V5L 4R3"}
  ]'::jsonb,
  parking_info = 'Canada Place: the Eastside Parkade (connected to the terminal) and nearby commercial lots on West Cordova St; rates are C$25–35/day. Reserve through the Port of Vancouver or independent lot operators. Ballantyne: surface lots adjacent to the terminal; less convenient for public transit.',
  transit_dropoff_info = 'Canada Place is directly served by the SkyTrain Waterfront Station (Expo and Canada Lines). From YVR airport: ~26 min via Canada Line — the most convenient airport-to-terminal public transit connection of any North American port. Taxis and rideshare (Lyft, Uber) drop off at the terminal front entrance. U.S. passengers require NEXUS/passport even for domestic embarkation.',
  arrival_advice = 'Canadians boarding here will need a valid passport or enhanced driver''s license for re-entry to Canada. U.S. citizens need a passport. Canada Place is in the heart of downtown Vancouver — explore before departure or arrive the night before to enjoy the waterfront. CBSA (Canada Border Services) may have line-ups; build in extra time if you have pre-boarding immigration to complete.'
WHERE port_code = 'YVR';

-- ── New York City (NYC) ───────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Manhattan Cruise Terminal — Pier 88",  "address": "711 12th Ave (at W 48th St), New York, NY 10019"},
    {"terminal": "Manhattan Cruise Terminal — Pier 90",  "address": "711 12th Ave (at W 50th St), New York, NY 10019"},
    {"terminal": "Manhattan Cruise Terminal — Pier 92",  "address": "711 12th Ave (at W 52nd St), New York, NY 10019"},
    {"terminal": "Brooklyn Cruise Terminal",             "address": "72 Bowne St, Red Hook, Brooklyn, NY 11231"}
  ]'::jsonb,
  parking_info = 'Manhattan terminals: no dedicated port garage; passengers use commercial garages on the West Side (rates $40–55/day for 7+ nights). Reserve in advance — garages fill quickly. Brooklyn terminal: limited surface parking available on-site; reserve through the terminal website. Most NYC-area guests use car service or transit.',
  transit_dropoff_info = 'Manhattan (Piers 88/90/92): no direct subway; closest subway stations (A/C/E at 50th St or C/E at 42nd St) are 10–15 min walk. Most passengers use taxis, car service, or rideshare (dedicated drop-off lanes on 12th Ave). From JFK: ~45 min by rideshare. From EWR: ~40 min. Brooklyn terminal: accessible by rideshare or B61 bus from downtown Brooklyn, but rideshare is strongly recommended with luggage.',
  arrival_advice = 'Midtown West traffic on sailing day is intense. Arrange car service with luggage capacity and allow 90 min from Midtown, 60 min from Brooklyn, 2+ hours from JFK. The Manhattan terminals are large multi-ship facilities — confirm your pier number. Consider arriving the evening before to avoid travel-day stress in one of the world''s busiest cities.'
WHERE port_code = 'NYC';

-- ── Boston (BOS) ─────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Black Falcon Cruise Terminal", "address": "1 Black Falcon Ave, Boston, MA 02210"}
  ]'::jsonb,
  parking_info = 'Limited on-site parking is available at the Black Falcon terminal; reserve through massport.com. Rates are posted on the Massport website. Most guests flying into Logan International (0.5 miles away) take advantage of the walkability or use the shuttle between Logan and the terminal.',
  transit_dropoff_info = 'Logan International Airport is approximately 0.5 miles from Black Falcon — the closest major airport of any North American cruise port. Rideshare and taxis take under 10 min from baggage claim. The Silver Line (SL1) from Logan to South Station, then Water Shuttle to Courthouse/Fan Pier area (0.7 mi walk) is an option. A dedicated shuttle between Logan arrivals and the Black Falcon terminal is often available; check with the terminal.',
  arrival_advice = 'The proximity to Logan makes Boston a convenient embarkation port; many passengers fly in day-of without issue. The Sumner/Callahan tunnels connect Logan to the Seaport District — traffic is light outside rush hours. Arrive 2.5 hours before departure. Boston is a compact embarkation terminal; boarding is typically efficient.'
WHERE port_code = 'BOS';

-- ── Baltimore (BAL) ───────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "South Locust Point Cruise Terminal (Smith Terminal)", "address": "2001 E McComas St, Baltimore, MD 21230"}
  ]'::jsonb,
  parking_info = 'Covered and surface parking is available at the South Locust Point terminal. Reserve through mpa.maryland.gov. The terminal is fully self-contained with garage parking adjacent to the building, making it convenient for drive-to passengers.',
  transit_dropoff_info = 'No direct public transit to the terminal. Rideshare and taxis are the most practical option from BWI Airport (~20 min), Reagan National (DCA, ~55 min), or Dulles (IAD, ~75 min). Designated drop-off zones are at the terminal entrance. Some cruise lines offer hotel packages with shuttle transfers.',
  arrival_advice = 'Baltimore is a heavily drive-to port with excellent highway access (I-95, I-295, I-895). Allow extra time on weekends when downtown Baltimore events can congest Key Highway. The terminal is modern and well-organized. Arrive 2.5–3 hours before sailing. No international flights into BWI connect tight to embarkation — book a night before if flying from the West Coast.'
WHERE port_code = 'BAL';

-- ── New Orleans (MSY) ─────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Julia Street Cruise Terminal",  "address": "1 Julia St, New Orleans, LA 70130"},
    {"terminal": "Erato Street Cruise Terminal",  "address": "920 Convention Center Blvd, New Orleans, LA 70130"}
  ]'::jsonb,
  parking_info = 'On-site parking lots at both terminals; pre-purchase through portnola.com for the best rates. The lots are adjacent to the terminal buildings — no shuttle required. Parking sells out for holiday sailings, so book as soon as your cruise is confirmed.',
  transit_dropoff_info = 'Louis Armstrong International Airport (MSY) is ~35–45 min by rideshare from the cruise terminals. RTA Bus Route 11 reaches the Convention Center area with some walking. Taxis are available at the airport taxi stand. Rideshare drop-off is directly at the terminal entrances on Julia St and Convention Center Blvd.',
  arrival_advice = 'New Orleans embarkation morning can catch passengers off-guard — many arrive the night before and stay in the French Quarter or Warehouse District (both within walking distance). The Convention Center area is walkable from major downtown hotels. Allow 3 hours from MSY Airport by car. Confirm which of the two terminals your cruise line uses — they are adjacent but have separate check-in processes.'
WHERE port_code = 'MSY';

-- ── Los Angeles / San Pedro (LAX) ─────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "World Cruise Center — Berth 46",    "address": "100 Swinford St, San Pedro, CA 90731"},
    {"terminal": "World Cruise Center — Berth 92/93", "address": "638 Sampson Way, San Pedro, CA 90731"}
  ]'::jsonb,
  parking_info = 'Port of Los Angeles World Cruise Center has parking structures near each berth. Reserve through the port website; rates are per day and posted seasonally. Complimentary shuttle carts move passengers between the parking area and terminal entrance.',
  transit_dropoff_info = 'LAX Airport is approximately 35–45 min by rideshare from San Pedro (without heavy traffic; allow 60–90 min during peak hours). There is no direct public transit from LAX to San Pedro — rideshare or cruise line transfers are the standard options. Designated rideshare and taxi drop-off zones are at each berth entrance.',
  arrival_advice = 'The 110 Freeway south to San Pedro can be extremely congested during LA rush hours. Schedule arrival at the terminal before 11 AM if possible to avoid the worst traffic. Confirm your berth number (46, 92, or 93) before arriving — they are at different ends of the complex. Pre-ordered car service to/from a confirmed berth address is strongly recommended over rideshare.'
WHERE port_code = 'LAX';

-- ── San Diego (SAN) ───────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "B Street Cruise Ship Terminal",    "address": "1140 N Harbor Dr, San Diego, CA 92101"},
    {"terminal": "10th Avenue Marine Terminal",      "address": "1000 10th Ave, San Diego, CA 92101"}
  ]'::jsonb,
  parking_info = 'B Street Terminal: nearby public lots and commercial garages on Harbor Dr; no dedicated terminal garage. 10th Avenue: surface lots near the terminal. Both terminals are in downtown San Diego within 0.5 miles of numerous independent parking facilities. Rates vary; expect $15–25/day.',
  transit_dropoff_info = 'San Diego International Airport (SAN) is 2 miles from B Street Terminal — one of the shortest airport-to-terminal distances in the country. Rideshare takes under 10 min. The MTS Tram (Trolley) does not directly serve the cruise terminals; rideshare is the practical choice. Designated drop-off is at the terminal curb on Harbor Dr.',
  arrival_advice = 'San Diego is a relaxed, easy-to-navigate embarkation port. The compact downtown location means minimal logistics stress. Arrive 2–2.5 hours before sailing. If time allows, the Gaslamp Quarter and Seaport Village are immediately adjacent for a pre-cruise meal. Verify your terminal (B Street vs. 10th Ave) — they are 1 mile apart.'
WHERE port_code = 'SAN';

-- ── San Francisco (SFO) ───────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "James R. Herman Cruise Terminal — Pier 27", "address": "Pier 27, The Embarcadero, San Francisco, CA 94111"}
  ]'::jsonb,
  parking_info = 'No dedicated parking garage at Pier 27. The Embarcadero area has commercial lots within a few blocks; expect $30–45/day in this premium downtown location. Most San Francisco passengers arrive by taxi, rideshare, or BART. Cruise line transfers from SFO are the easiest option for air travelers.',
  transit_dropoff_info = 'BART from SFO Airport to Embarcadero Station is approximately 30 min and drops you 0.4 miles from Pier 27 — an excellent option for those arriving with manageable luggage. Rideshare and taxis are 30–45 min from SFO depending on Bay Bridge traffic. The F-Market historic streetcar stops near the Ferry Building (0.3 mi from Pier 27). Designated drop-off is on The Embarcadero at the pier entrance.',
  arrival_advice = 'San Francisco traffic is unpredictable — avoid the Bay Bridge approach during morning rush hour (7–10 AM). The waterfront location is scenic and walkable from Union Square and North Beach; consider staying nearby the night before. Arrive 2.5–3 hours before sailing. The Ferry Building Marketplace (0.3 mi) is a great spot for a final meal before boarding.'
WHERE port_code = 'SFO';

-- ── Long Beach (LGB) ─────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Long Beach Cruise Terminal", "address": "231 Windsor Way, Long Beach, CA 90802"}
  ]'::jsonb,
  parking_info = 'On-site parking structure adjacent to the Long Beach Cruise Terminal. Reserve at polb.com/cruise. The terminal garage is covered and secure, making it a convenient choice for drive-to guests. Rates are posted on the port website.',
  transit_dropoff_info = 'Long Beach Airport (LGB) is approximately 10–15 min by rideshare. LAX is 25–35 min (traffic-dependent). Metro A Line (Blue) to Downtown Long Beach, then rideshare to the terminal (no direct rail). Dedicated drop-off loop is at the terminal entrance on Windsor Way.',
  arrival_advice = 'Long Beach is a comfortable alternative to San Pedro for LA-area sailings — less congested and easier to navigate. Allow 2.5 hours before sailing. The Queen Mary is visible from the terminal and worth a look from the pier if you arrive early. Confirm you are at Long Beach Cruise Terminal (not Port of LA in San Pedro) if multiple ships are departing the region on the same day.'
WHERE port_code = 'LGB';

-- ── Tampa (TPA) ───────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Cruise Terminal 2", "address": "651 Channelside Dr, Tampa, FL 33602"},
    {"terminal": "Cruise Terminal 3", "address": "815 Channelside Dr, Tampa, FL 33602"}
  ]'::jsonb,
  parking_info = 'Covered parking garages are located adjacent to both terminals in the Channelside district. Book in advance at tampaport.com — rates are per night and sell out for peak sailings. Luggage porters are available at the curb when the garages fill.',
  transit_dropoff_info = 'Tampa International Airport (TPA) is approximately 20–25 min by rideshare. HART (Hillsborough Area Regional Transit) does not directly serve the cruise terminals; rideshare is the practical option. Designated rideshare and taxi drop-off zones are at each terminal entrance on Channelside Dr.',
  arrival_advice = 'The Channelside district has undergone significant development — the area around the terminals now has excellent restaurants and bars for pre-cruise meals. Arrive 2.5–3 hours before sailing. Channelside Dr can be slow on weekends; approach from I-4 or Adamo Dr rather than downtown Kennedy Blvd when possible. Confirm your terminal number (2 or 3) in advance.'
WHERE port_code = 'TPA';

-- ── Jacksonville (JAX) ────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "JAXPORT Cruise Terminal", "address": "9810 August Dr, Jacksonville, FL 32226"}
  ]'::jsonb,
  parking_info = 'Surface parking is available adjacent to the JAXPORT Cruise Terminal on Blount Island. Pre-pay and reserve through jaxport.com for guaranteed availability. The lot is secured and a short walk from the terminal entrance.',
  transit_dropoff_info = 'Jacksonville International Airport (JAX) is approximately 20 min by rideshare. No public bus service to Blount Island. Rideshare and taxis are the sole practical transit options. The terminal is in an industrial port area — a rideshare is essential, not optional.',
  arrival_advice = 'Jacksonville operates a smaller terminal with limited sailing volume, which typically means faster and less crowded embarkation than major ports. Allow 2–2.5 hours. The terminal is on Blount Island in the St. Johns River industrial district — plan your navigation in advance (GPS to "9810 August Dr, Jacksonville, FL" is reliable). Dining options near the terminal are sparse; eat before you leave the hotel.'
WHERE port_code = 'JAX';

-- ── Mobile (MOB) ─────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Alabama Cruise Terminal", "address": "201 S Water St, Mobile, AL 36602"}
  ]'::jsonb,
  parking_info = 'Surface lots adjacent to the Alabama Cruise Terminal at the Mobile waterfront. Rates and reservation information available through the terminal operator. The compact facility means parking is close to the terminal building.',
  transit_dropoff_info = 'Mobile Regional Airport (MOB) is approximately 15 min by rideshare. No public transit serves the cruise terminal. Rideshare and taxis are the standard options. The terminal is in downtown Mobile on the waterfront, with easy highway access from I-10 and I-65.',
  arrival_advice = 'Mobile is one of the smaller home-ports with a single active cruise terminal. Embarkation is typically relaxed and efficient. Downtown Mobile has a walkable historic district nearby — a pleasant pre-departure stop. Allow 2 hours before sailing. Confirm current cruise schedules; Mobile''s home-port frequency is seasonal.'
WHERE port_code = 'MOB';

-- ── Norfolk (ORF) ─────────────────────────────────────────────────────────────
UPDATE public.port_info_chunks SET
  terminal_addresses = '[
    {"terminal": "Half Moone Cruise and Celebration Center", "address": "101 Waterside Dr, Norfolk, VA 23510"}
  ]'::jsonb,
  parking_info = 'Surface and garage parking is available near the Half Moone terminal in downtown Norfolk. The MacArthur Center garage and surrounding city garages are within walking distance. Rates vary; expect $15–20/day. Reserve early for cruise embarkation days.',
  transit_dropoff_info = 'Norfolk International Airport (ORF) is approximately 15 min by rideshare. Hampton Roads Transit (HRT) operates light rail (The Tide) to downtown Norfolk, with the Monticello station 0.5 miles from Half Moone — an option for light packers. Rideshare drop-off is at the terminal entrance on Waterside Dr.',
  arrival_advice = 'Norfolk is the smallest major home-port on the East Coast. The terminal is in the Waterside district — one of Norfolk''s most vibrant neighborhoods with dining and entertainment steps away. Arrive 2–2.5 hours before sailing. The Hampton Roads harbor views from the terminal are worth arriving early for. Confirm terminal access via Waterside Dr (not Town Point Park, which is adjacent and can cause confusion on GPS).'
WHERE port_code = 'ORF';
