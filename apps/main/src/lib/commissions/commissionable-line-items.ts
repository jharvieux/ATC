// §12.5 — Commissionable fare reference data.
// Maps each line-item category to its commissionable status.
// Consumed by Part 4 commission math and quote PDF rendering.

export type CommissionableStatus =
  | "always_commissionable"
  | "never_commissionable"
  | "reduces_commissionable_fare"
  | "line_specific_varies";

export interface LineItemCategory {
  key: string;
  label: string;
  status: CommissionableStatus;
  notes?: string;
}

export const COMMISSIONABLE_LINE_ITEMS: readonly LineItemCategory[] = [
  { key: "base_cruise_fare",        label: "Base cruise fare",                     status: "always_commissionable" },
  { key: "cabin_upgrade",           label: "Cabin category upgrade",               status: "always_commissionable" },
  { key: "loyalty_discount",        label: "Loyalty discount",                     status: "reduces_commissionable_fare" },
  { key: "taxes_port_fees",         label: "Taxes / port fees",                    status: "never_commissionable" },
  { key: "gratuities_prepaid",      label: "Gratuities (pre-paid)",               status: "never_commissionable", notes: "Usually; varies by line" },
  { key: "insurance",               label: "Insurance",                            status: "never_commissionable" },
  { key: "specialty_dining",        label: "Specialty dining",                     status: "line_specific_varies" },
  { key: "beverage_packages",       label: "Beverage packages",                    status: "always_commissionable", notes: "Most lines" },
  { key: "excursions_cruise_line",  label: "Excursions (booked through cruise line)", status: "always_commissionable" },
];
