# Employee Attendance System

A real-time attendance system with separate Employee and Admin portals.

## Core rules
- Employees check in when they arrive; there is no fixed office start time.
- Check-in time cannot be edited by employees.
- Employees can start and end lunch; actual lunch duration is recorded.
- Standard working target: 8 hours.
- Up to 1 hour of lunch is included in the 9-hour office span.
- Overtime starts only after 9 hours of working/attendance duration according to the configured attendance rule.
- Only one admin account is allowed.
- Admin can manage employees and edit attendance records.
- Admin and Employee portals share one central data source.

## Planned structure
- `employee/` — Employee portal
- `admin/` — Admin portal
- `backend/` — API, authentication, attendance calculations
- `docs/` — system documentation

## Status
Initial project setup.