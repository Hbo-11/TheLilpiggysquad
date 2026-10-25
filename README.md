# The Li'l Piggy Squad 🐷

A comix company website — playful, modern, liquid-glass design in pink / purple / white with
turquoise accents (used sparingly).

## Features
- **Home** with three catalogue sections — **Coming Soon** (The Little Piggy Squad 2),
  **New** (The Little Piggy Squad 1) and **Out Now** (The Little Piggy Squad 1 &
  The Little Piggy Squad Origins), plus an **Our Partners** moving banner (yellow with a bold
  black outline) featuring Gmail, Microsoft Teams, Microsoft Word, Claude and ChatGPT.
- **About Us** — Three-Sided-Cube-inspired team cards with a photo on a dotted background that
  flip on hover to reveal a fun fact.
- **Accounts & Profiles** — sign up, log in and set up a personal profile (avatar colour, emoji,
  bio, favourite book). Every profile is unique to the user.
- **Orders** — only account holders can place and view orders; order history lives on the profile.

## Tech
- Frontend: React + Vite + React Router + Framer Motion (smooth motion everywhere).
- Backend: Express with a dependency-free JSON store, session cookies and bcrypt password hashing.

## Run locally
```bash
npm install
npm run build      # builds the frontend into /dist
npm start          # serves the app + API on http://localhost:4123
```
`npm run dev` runs the Vite dev server with the API proxied to :4123.

## Deploy (Harvester)
```bash
npm install && npm run build
PORT=4123 node server.js
```
The Express server serves the built frontend and the API from a single port.

## Apex AI notification system (`apex/`)
A separate, self-contained workspace for the Apex AI notification system (Expo app, Supabase backend,
shared logic and tests). It does not affect this website. See [`apex/README.md`](apex/README.md).
