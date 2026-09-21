# QuickBoard — Daily Capture Kanban (Option B: hosted + auto-sync)

## Your question: "If we make changes to the app, will it show on phone?"
Yes — two kinds of changes:
1. **Data changes (cards, boards):** instant via Firebase. Add a card on Mac → appears on Samsung in ~1-2s. No redeploy.
2. **Code changes (new buttons, layout, fixes I make):** show on phone after I redeploy the hosted folder + you refresh once. The service worker is now network-first for the page (v2), so 1 refresh pulls the new version. Check footer: `v2 • sync ON`.

## Option B setup (15 min, once)

### 1. Firebase (free) — 5 min
1. Go to console.firebase.google.com → Add project (name: quickboard, no Analytics needed)
2. Build → **Firestore Database** → Create database → Start in **production mode** → pick closest region
3. Build → **Authentication** → Sign-in method → Enable **Anonymous**
4. Project Settings (gear) → General → Your apps → `</>` Web app → nickname quickboard → Register → copy the `firebaseConfig` JSON
5. Firestore → Rules → replace with (personal single-key; anyone with key can read/write — fine for personal MVP):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /quickboards/{doc} { allow read, write: if true; }
  }
}
```
Publish.

### 2. Bake config into app — 2 min
Open `firebase-config.js` in this folder, replace `window.QB_FIREBASE_CONFIG = null` with your JSON, set `window.QB_SYNC_KEY = "my-tasks-123"` (same string = same shared board). Save.

### 3. Host free — 1 min (pick one)
- **Netlify Drop (easiest):** app.netlify.com/drop → drag this whole `quickboard-app` folder → get `https://xxx.netlify.app`
- **Vercel:** vercel.com → Add New Project → Upload → drag folder
- **GitHub Pages:** push folder to repo → Settings → Pages → Deploy from branch
No build step — it's static.

### 4. Phone — 1 min
Samsung Chrome → open your hosted URL → ⋮ → **Add to Home screen** → open from icon (standalone app mode). Mac Chrome: same URL (bookmark it; stop using localhost).
Open on both → add test card on Mac → watch it appear on phone.

### 5. Later code updates
I edit files → you drag-drop the folder to Netlify again (same site) → refresh phone once → footer version confirms. Data is untouched (lives in Firebase, not in deploy).

## Local dev
```bash
cd ~/quickboard-app
python3 -m http.server 8000
# http://localhost:8000
```
