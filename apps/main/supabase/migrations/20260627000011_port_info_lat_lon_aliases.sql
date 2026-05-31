-- #484 — lat/lon + name aliases for port_info_chunks (§23.4).
--
-- The multi-day weather chart (PR #482) needs {latitude, longitude} per stop.
-- The production sender resolves ports-of-call by NAME (CruiseMapper emits
-- port labels, not IATA codes), so name_aliases lets one row match the several
-- strings CruiseMapper uses for the same place ("Roatán, Honduras" / "Roatan"
-- / "Mahogany Bay").
--
-- name_aliases is TEXT[] (not JSONB): supabase-js `.contains(col, [value])`
-- serializes a JS array to a Postgres array literal (`cs.{value}` → `@>
-- '{value}'`), which is correct for text[] but malformed against jsonb. TEXT[]
-- makes the documented `.contains` array semantics work without quirks.
--
-- Coordinates are port/city-center approximations. Open-Meteo's grid is ~0.1°
-- (~11 km), so this precision is more than adequate for a forecast lookup.

ALTER TABLE public.port_info_chunks
  ADD COLUMN IF NOT EXISTS latitude     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude    DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS name_aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS port_info_chunks_lat_lon_idx
  ON public.port_info_chunks (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- GIN index for array containment (name_aliases @> ARRAY['...']) alias lookups.
CREATE INDEX IF NOT EXISTS port_info_chunks_name_aliases_idx
  ON public.port_info_chunks USING GIN (name_aliases);

-- ── Seed coordinates for the 17 NA departure ports already present ───────────
UPDATE public.port_info_chunks AS p SET
  latitude = v.lat, longitude = v.lon, name_aliases = v.aliases
FROM (VALUES
  ('MIA', 25.7617::DOUBLE PRECISION, -80.1918::DOUBLE PRECISION, ARRAY['Miami','PortMiami','Miami, Florida']),
  ('PCV', 28.4058, -80.6028, ARRAY['Port Canaveral','Port Canaveral, Florida','Cape Canaveral']),
  ('GAL', 29.3013, -94.7977, ARRAY['Galveston','Galveston, Texas']),
  ('SEA', 47.6062, -122.3321, ARRAY['Seattle','Seattle, Washington']),
  ('YVR', 49.2827, -123.1207, ARRAY['Vancouver','Vancouver, British Columbia','Vancouver, BC, Canada']),
  ('NYC', 40.7128, -74.0060, ARRAY['New York','New York City','Manhattan','Brooklyn','New York, New York']),
  ('BOS', 42.3601, -71.0589, ARRAY['Boston','Boston, Massachusetts']),
  ('BAL', 39.2904, -76.6122, ARRAY['Baltimore','Baltimore, Maryland']),
  ('MSY', 29.9511, -90.0715, ARRAY['New Orleans','New Orleans, Louisiana']),
  ('LAX', 33.7405, -118.2746, ARRAY['Los Angeles','San Pedro','Los Angeles, California']),
  ('SAN', 32.7157, -117.1611, ARRAY['San Diego','San Diego, California']),
  ('SFO', 37.7749, -122.4194, ARRAY['San Francisco','San Francisco, California']),
  ('LGB', 33.7521, -118.1937, ARRAY['Long Beach','Long Beach, California']),
  ('TPA', 27.9506, -82.4572, ARRAY['Tampa','Tampa, Florida']),
  ('JAX', 30.3322, -81.6557, ARRAY['Jacksonville','Jacksonville, Florida']),
  ('MOB', 30.6944, -88.0431, ARRAY['Mobile','Mobile, Alabama']),
  ('ORF', 36.8508, -76.2859, ARRAY['Norfolk','Norfolk, Virginia'])
) AS v(code, lat, lon, aliases)
WHERE p.port_code = v.code;

-- ── ~30 popular ports of call ────────────────────────────────────────────────
-- Codes are IATA where one exists (recognizable, stable), otherwise an internal
-- short code. These rows carry coordinates + aliases only; terminal/parking
-- content (#488) is N/A for ports of call rendered in the email.
INSERT INTO public.port_info_chunks (port_code, port_name, latitude, longitude, name_aliases)
VALUES
  -- Caribbean / Bahamas / Mexico
  ('NAS',  'Nassau, Bahamas',            25.0780,  -77.3389, ARRAY['Nassau','Nassau, Bahamas','Nassau, The Bahamas']),
  ('CZM',  'Cozumel, Mexico',            20.4230,  -86.9223, ARRAY['Cozumel','Cozumel, Mexico']),
  ('RTB',  'Roatán, Honduras',           16.3000,  -86.5300, ARRAY['Roatan','Roatán','Roatán, Honduras','Roatan, Honduras','Mahogany Bay','Coxen Hole']),
  ('CMA',  'Costa Maya, Mexico',         18.7333,  -87.6833, ARRAY['Costa Maya','Costa Maya, Mexico','Mahahual']),
  ('GCM',  'George Town, Grand Cayman',  19.2866,  -81.3744, ARRAY['George Town','Grand Cayman','Georgetown','George Town, Grand Cayman','Cayman Islands']),
  ('FMJ',  'Falmouth, Jamaica',          18.4900,  -77.6500, ARRAY['Falmouth','Falmouth, Jamaica']),
  ('OCJ',  'Ocho Rios, Jamaica',         18.4070,  -77.1030, ARRAY['Ocho Rios','Ocho Rios, Jamaica']),
  ('MBJ',  'Montego Bay, Jamaica',       18.4762,  -77.8939, ARRAY['Montego Bay','Montego Bay, Jamaica']),
  ('STT',  'St. Thomas, USVI',           18.3419,  -64.9307, ARRAY['St. Thomas','Saint Thomas','Charlotte Amalie','St. Thomas, USVI','St Thomas']),
  ('SXM',  'Philipsburg, St. Maarten',   18.0255,  -63.0450, ARRAY['St. Maarten','Sint Maarten','Philipsburg','St Maarten','St. Maarten, Netherlands Antilles']),
  ('SJU',  'San Juan, Puerto Rico',      18.4655,  -66.1057, ARRAY['San Juan','San Juan, Puerto Rico']),
  ('AUA',  'Oranjestad, Aruba',          12.5092,  -70.0086, ARRAY['Aruba','Oranjestad','Oranjestad, Aruba']),
  ('CUR',  'Willemstad, Curaçao',        12.1091,  -68.9316, ARRAY['Curacao','Curaçao','Willemstad','Willemstad, Curaçao']),
  ('BON',  'Kralendijk, Bonaire',        12.1500,  -68.2667, ARRAY['Bonaire','Kralendijk','Kralendijk, Bonaire']),
  ('BGI',  'Bridgetown, Barbados',       13.0969,  -59.6145, ARRAY['Barbados','Bridgetown','Bridgetown, Barbados']),
  ('SLU',  'Castries, St. Lucia',        14.0101,  -60.9875, ARRAY['St. Lucia','Saint Lucia','Castries','St Lucia','Castries, St. Lucia']),
  ('ANU',  'St. John''s, Antigua',       17.1274,  -61.8468, ARRAY['Antigua','St. John''s','Saint John''s','St Johns','Antigua and Barbuda']),
  ('GDT',  'Grand Turk',                 21.4664,  -71.1390, ARRAY['Grand Turk','Grand Turk, Turks and Caicos','Cockburn Town']),
  ('BIM',  'Bimini, Bahamas',            25.7340,  -79.2960, ARRAY['Bimini','Bimini, Bahamas','South Bimini']),
  ('CCAY', 'CocoCay, Bahamas',           25.8200,  -77.9400, ARRAY['CocoCay','Coco Cay','Perfect Day at CocoCay','Little Stirrup Cay']),
  ('HMC',  'Half Moon Cay, Bahamas',     24.5800,  -75.9400, ARRAY['Half Moon Cay','Little San Salvador Island']),
  -- Alaska
  ('JNU',  'Juneau, Alaska',             58.3019,  -134.4197, ARRAY['Juneau','Juneau, Alaska','Juneau, AK']),
  ('SGY',  'Skagway, Alaska',            59.4583,  -135.3139, ARRAY['Skagway','Skagway, Alaska','Skagway, AK']),
  ('KTN',  'Ketchikan, Alaska',          55.3422,  -131.6461, ARRAY['Ketchikan','Ketchikan, Alaska','Ketchikan, AK']),
  ('SIT',  'Sitka, Alaska',              57.0531,  -135.3300, ARRAY['Sitka','Sitka, Alaska','Sitka, AK']),
  ('ICY',  'Icy Strait Point, Alaska',   58.1300,  -135.4400, ARRAY['Icy Strait Point','Hoonah','Icy Strait Point, Alaska']),
  -- Mexican Riviera
  ('CSL',  'Cabo San Lucas, Mexico',     22.8905,  -109.9167, ARRAY['Cabo San Lucas','Cabo','Cabo San Lucas, Mexico','Los Cabos']),
  ('PVR',  'Puerto Vallarta, Mexico',    20.6534,  -105.2253, ARRAY['Puerto Vallarta','Puerto Vallarta, Mexico']),
  ('MZT',  'Mazatlán, Mexico',           23.2494,  -106.4111, ARRAY['Mazatlan','Mazatlán','Mazatlán, Mexico','Mazatlan, Mexico']),
  ('ENS',  'Ensenada, Mexico',           31.8667,  -116.6000, ARRAY['Ensenada','Ensenada, Mexico'])
ON CONFLICT (port_code) DO UPDATE SET
  port_name    = EXCLUDED.port_name,
  latitude     = EXCLUDED.latitude,
  longitude    = EXCLUDED.longitude,
  name_aliases = EXCLUDED.name_aliases;
