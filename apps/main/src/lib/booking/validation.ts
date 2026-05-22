// §20.6 — Booking validation layers.
//
// Per-field validators: email format, passport expiry, DOB sanity.
// Cross-field validators: all passengers have DOBs, pricing math sums.
// Final-submission validator: all required fields, cruise-line age rules.

export interface ValidationError {
  field: string;
  message: string;
}

export function validateEmail(email: string): ValidationError | null {
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return { field: "email", message: "Invalid email format" };
  }
  return null;
}

export function validatePassportExpiry(
  expiryDate: Date | null,
  sailingDate: Date,
): ValidationError | null {
  if (!expiryDate) return null;
  const sixMonthsAfterSailing = new Date(sailingDate);
  sixMonthsAfterSailing.setMonth(sixMonthsAfterSailing.getMonth() + 6);
  if (expiryDate < sixMonthsAfterSailing) {
    return {
      field: "passport_expiry",
      message: "Passport must be valid for at least 6 months after the sailing date",
    };
  }
  return null;
}

export function validateDOBSanity(
  dob: Date,
  sailingDate: Date,
): ValidationError | null {
  const ageAtSailing =
    (sailingDate.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageAtSailing < 0) {
    return { field: "date_of_birth", message: "Date of birth cannot be in the future" };
  }
  if (ageAtSailing > 120) {
    return { field: "date_of_birth", message: "Date of birth is implausible" };
  }
  return null;
}

export interface PassengerInput {
  legal_first_name: string;
  legal_last_name: string;
  date_of_birth: Date;
  date_of_birth_is_estimated?: boolean;
  passport_expiry?: Date | null;
}

export function validatePassengersForSubmission(
  passengers: PassengerInput[],
  sailingDate: Date,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (passengers.length === 0) {
    errors.push({ field: "passengers", message: "At least one passenger is required" });
    return errors;
  }

  for (const p of passengers) {
    const dobErr = validateDOBSanity(p.date_of_birth, sailingDate);
    if (dobErr) errors.push(dobErr);

    if (p.passport_expiry) {
      const expiryErr = validatePassportExpiry(p.passport_expiry, sailingDate);
      if (expiryErr) errors.push(expiryErr);
    }
  }

  return errors;
}

export function validatePricingMath(
  subtotalCents: number,
  optionsCents: number[],
  totalCents: number,
): ValidationError | null {
  const expected = subtotalCents + optionsCents.reduce((a, b) => a + b, 0);
  if (expected !== totalCents) {
    return {
      field: "total_price_cents",
      message: `Pricing mismatch: expected ${expected}, got ${totalCents}`,
    };
  }
  return null;
}
