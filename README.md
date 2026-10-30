# Nabuzy

Nabil's own day planner: the timetable, climbing sessions, assignments, exams
and quizzes, and the five daily prayers. Everything syncs to Nabil's Supabase
project and comes back on any phone that signs in. Reminders come from there
too.

It's [Dayline](https://github.com/nabilhzq13/Dayline) made personal, with
Break's climbing log brought in. Unlike Dayline, it isn't for anyone else: the
Supabase project, the sign-in and the reminders are built in, with nothing to
set up.

**Open it:** https://nabilhzq13.github.io/Nabuzy/

## On the iPhone

1. Open the link above in **Safari**.
2. Tap **Share**, then **Add to Home Screen**, then **Add**.
3. Open Nabuzy from the home screen and sign in with the account in the
   Supabase project. The timetable, ticks, climbing sessions, prayers and
   assignments come in from it.
4. **Settings** (the gear), then **Reminders**, then **Turn on reminders**,
   allow notifications, then **Send a test**.

## What's in it

- **The Home button** at the bottom fans out the pages: Today, Week, Due,
  Climb, Solat and Schedule. Settings is the gear at the top of every page.
- **Today** is the day as a timetable, with free time between blocks and what's
  coming up. On a climbing block it says whether the gym is open.
- **Week** shows any day, with the gym's hours for it.
- **Due** has assignments, exams and quizzes, with their statuses and
  countdowns.
- **Climb** has the gym's opening hours, with the climbing blocks checked
  against them. It also has the hardest send and a grade chart, and every
  session: date, best send, how it felt, notes and up to four photos. Tap
  **Add** to log one.
- **Solat** ticks the five prayers against JAKIM's times and keeps qadha.
- **Schedule** lists every block to edit.

## Where the data lives

On the phone first. While signed in, it syncs to the Supabase project
`xuowahaymhsqfjcdxwuh`: one row per piece in `docs` (`blocks`, `done`,
`tasks`, `climbs`, `prefs`, `solat`, `solatSet`, `qadhaOld`, `reminders`), and
files and climbing photos in the private `files` store. Row level security keeps
it to the account. The key in `index.html` is the publishable kind.

The timetable, ticks, climbing sessions and prayers came across from Break's
project on 30 October 2026. Break's two climbing photos don't sync across by
themselves. In Break, **Settings**, **Back up**; then in Nabuzy, **Settings**,
**Restore from file**, and pick that file. A Break backup brings in its
climbing sessions and photos, and leaves everything else here as it is.

## Reminders

The `remind` Edge Function sends them. The pg_cron job `dayline-reminders` calls
it every minute. The key pair it signs with is in the table `push_vapid`, which
only the function can read. The public half is also in `index.html`.

Due dates, exams and quizzes get theirs 1 day and 1 hour before, until you
choose otherwise: in **Settings**, **Reminders**, under **Due dates, exams and
quizzes**, tap any mix of 1 week, 3 days, 1 day and 1 hour before. One that
would land in quiet hours comes the minute they end, if that's still before
it's due.

## Files

- `index.html`: the whole app, in one file with no build step.
- `sw.js`: works offline, and shows the reminders.
- `manifest.webmanifest`, `icon-*.png`: the home-screen app and its icon.
- `fonts/`: Inter (SIL Open Font License, see `fonts/OFL.txt`).
- `supabase/`: what the project has, as SQL, and the `remind` function.
  `nabuzy.sql` holds what Nabuzy added to Dayline's setup.

## Changing it

Edit `index.html`, then raise `CACHE` in `sw.js` (`nabuzy-v1` becomes
`nabuzy-v2`) so the phone picks up the new version.
