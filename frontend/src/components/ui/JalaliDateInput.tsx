'use client';

import { useEffect, useState } from 'react';

type JalaliDateInputProps = {
  value: string;
  onChange: (gregorianIsoDate: string) => void;
  className?: string;
  required?: boolean;
  disabled?: boolean;
  min?: string;
  max?: string;
  'aria-label'?: string;
  id?: string;
};

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toLatinDigits(value: string): string {
  return value.replace(/[۰-۹٠-٩]/g, (digit) => {
    const persian = PERSIAN_DIGITS.indexOf(digit);
    return String(persian >= 0 ? persian : ARABIC_DIGITS.indexOf(digit));
  });
}

function formatJalali(iso: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}/${get('month')}/${get('day')}`;
}

// Convert a Jalali date to Gregorian without relying on an online service or locale data.
function jalaliToGregorian(jy: number, jm: number, jd: number): string | null {
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd) || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const jYear = jy + 1595;
  let days = -355668 + 365 * jYear + Math.floor(jYear / 33) * 8 + Math.floor(((jYear % 33) + 3) / 4) + jd;
  days += jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186;
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthLengths = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > monthLengths[gm]) {
    gd -= monthLengths[gm];
    gm++;
  }
  if (gm > 12) return null;
  const iso = `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
  // Round-trip validation catches invalid month lengths and leap-day mistakes.
  if (formatJalali(iso) !== `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`) return null;
  return iso;
}

function parseJalali(value: string): string | null {
  const normalized = toLatinDigits(value.trim()).replace(/[.\-]/g, '/');
  const match = normalized.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!match) return null;
  return jalaliToGregorian(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function JalaliDateInput({
  value, onChange, className, required, disabled, min, max, 'aria-label': ariaLabel, id,
}: JalaliDateInputProps) {
  const [draft, setDraft] = useState(() => formatJalali(value));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(formatJalali(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    if (!draft.trim()) {
      setInvalid(false);
      if (!required) onChange('');
      return;
    }
    const parsed = parseJalali(draft);
    if (!parsed || (min && parsed < min) || (max && parsed > max)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(formatJalali(parsed));
    if (parsed !== value) onChange(parsed);
  };

  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      dir="ltr"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id || 'jalali-date'}-error` : undefined}
      placeholder="۱۴۰۵/۰۸/۰۵"
      value={draft}
      required={required}
      disabled={disabled}
      className={className}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
        if (!event.target.value.trim() && !required) onChange('');
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          (event.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}
