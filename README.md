# Employee Attendance System

A real-time office attendance system with connected Employee and Admin portals using one central backend/database.

## Portals
- `/employee` — employee check-in, lunch tracking, check-out and live hours
- `/admin` — admin-only employee management, attendance editing, filters and CSV export
- `/` — secure login selector

## Attendance rules
- Employees check in when they actually arrive; there is no fixed office start time.
- Employee check-in time is locked and cannot be edited by the employee.
- Employees can start and end lunch; actual lunch duration is recorded.
- Normal work target is 8 hours.
- Overtime starts only after the additional 1-hour allowance, i.e. after 9 hours of net working time.
- Employees cannot check out while lunch is still active.
- Only one administrator account is supported.
- Admin can add, edit and activate/deactivate employees.
- Admin can edit attendance records and view monthly/employee-filtered reports.
- Reports can be exported as CSV.

## Tech stack
- Node.js + Express
- SQLite + better-sqlite3
- JWT authentication
- Responsive HTML/CSS/JavaScript frontend

## Default admin setup
For production, set environment variables:
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `JWT_SECRET`
- `PORT` (optional)

If no admin exists, development defaults are `admin@example.com` / `admin123`. Change these before production use.

## Run
```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Important production note
Passwords are currently stored directly in SQLite for this initial implementation. Before public production deployment, password hashing, HTTPS, stronger secret management and rate limiting should be added.