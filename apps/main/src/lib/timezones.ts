// Curated US-focused timezone list for the onboarding profile stage (§15.3).
// Labels use IANA identifiers; display names are human-readable.

export interface TimezoneOption {
  value: string; // IANA tz identifier
  label: string; // display name
  offset: string; // UTC offset (representative)
}

export const TIMEZONES: TimezoneOption[] = [
  { value: "America/New_York",    label: "Eastern Time (ET)",          offset: "UTC-5/4" },
  { value: "America/Chicago",     label: "Central Time (CT)",           offset: "UTC-6/5" },
  { value: "America/Denver",      label: "Mountain Time (MT)",          offset: "UTC-7/6" },
  { value: "America/Los_Angeles", label: "Pacific Time (PT)",           offset: "UTC-8/7" },
  { value: "America/Anchorage",   label: "Alaska Time (AKT)",           offset: "UTC-9/8" },
  { value: "Pacific/Honolulu",    label: "Hawaii Time (HT)",            offset: "UTC-10"  },
  { value: "America/Phoenix",     label: "Arizona Time (no DST)",       offset: "UTC-7"   },
  { value: "America/Puerto_Rico", label: "Atlantic Time — Puerto Rico", offset: "UTC-4"   },
  { value: "Pacific/Guam",        label: "Chamorro Time (ChST)",        offset: "UTC+10"  },
];
