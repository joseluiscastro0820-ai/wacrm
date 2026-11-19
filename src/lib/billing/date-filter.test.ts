import { describe, it, expect } from 'vitest'
import { isWithinDateRange } from './date-filter'

describe('isWithinDateRange', () => {
  it('includes everything when neither bound is given', () => {
    expect(isWithinDateRange('2026-01-15T10:00:00Z')).toBe(true)
    expect(isWithinDateRange('2026-01-15T10:00:00Z', '', '')).toBe(true)
    expect(isWithinDateRange('2026-01-15T10:00:00Z', null, null)).toBe(true)
  })

  it('excludes a date before the "from" bound', () => {
    expect(isWithinDateRange('2026-01-04T23:59:00', '2026-01-05')).toBe(false)
  })

  it('includes a date exactly on the "from" bound (start of day)', () => {
    expect(isWithinDateRange('2026-01-05T00:00:00', '2026-01-05')).toBe(true)
    expect(isWithinDateRange('2026-01-05T23:59:00', '2026-01-05')).toBe(true)
  })

  it('excludes a date after the "to" bound', () => {
    expect(isWithinDateRange('2026-01-06T00:00:01', undefined, '2026-01-05')).toBe(false)
  })

  it('includes a date exactly on the "to" bound (end of day)', () => {
    expect(isWithinDateRange('2026-01-05T23:59:59', undefined, '2026-01-05')).toBe(true)
    expect(isWithinDateRange('2026-01-05T00:00:00', undefined, '2026-01-05')).toBe(true)
  })

  it('applies both bounds together, as an inclusive range', () => {
    expect(isWithinDateRange('2026-01-10T12:00:00', '2026-01-05', '2026-01-15')).toBe(true)
    expect(isWithinDateRange('2026-01-01T12:00:00', '2026-01-05', '2026-01-15')).toBe(false)
    expect(isWithinDateRange('2026-01-20T12:00:00', '2026-01-05', '2026-01-15')).toBe(false)
  })
})
