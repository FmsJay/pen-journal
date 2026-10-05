# Pen Journal

A handwritten journal for the Galaxy S-Pen. A single codebase runs as both:

- **the Android app.** You install it from Chrome on the Samsung and it runs full-screen from its own home-screen icon, offline too.
- **the web app.** You open the same URL in any desktop browser, sign in to Google, and read or edit the same journal.

Both sync through one file in your Google Drive.

## Using it

| Action | How |
|---|---|
| Write | S-Pen (pressure-sensitive). On desktop, use the mouse. |
| Erase | Hold the **S-Pen side button** while writing, or pick 🧽. The eraser removes whole strokes. |
| Scroll a long page | Drag up or down with your finger. Writing near the bottom adds more paper, and so does pulling up past the end (up to 8 sheets per page). |
| Flip pages | **Swipe with your finger**, or tap ‹ ›, or use the arrow keys. Fingers never draw, so a resting palm won't scribble. |
| New page | ＋, or flip past the last page |
| Title / keywords, date, category | The handwritten-style header on each page |
| Typed sticky | 📝. Drag it by its top bar, 🎨 changes its colour, ✕ removes it. |
| Voice memo sticky | 🎙 starts recording and 🎙 again stops. The memo becomes a playable sticky with a caption. |
| Search / sort | 🔍. Search by keyword (title, sticky text, category), category, and date range, and sort by date or category. **Flip through results** turns the matches into a book you can page through. The "filtered ✕" badge clears it. |
| Categories, Drive, export | ⋮ menu |

Handwriting itself isn't text-searchable. Put the words you'll want to search for in the page title or a sticky.

## Google Drive backup (one-time, ~5 minutes)

Google requires each app to have its own OAuth Client ID. It's free.

1. Go to <https://console.cloud.google.com/> → create a project (e.g. "Pen Journal").
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → External → fill in the app name and your email → under **Test users** add your Gmail address. (Leaving the app in Testing mode is fine for personal use.)
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized JavaScript origins**, add the URL you host the app at (see below), e.g. `https://YOURNAME.github.io`.
5. Copy the Client ID. In the app, open ⋮ → paste it → **Save & sign in**.

What gets saved, all under **My Drive › Pen Journal**:
- `pen-journal-backup.json`: the live, rolling copy that the phone and the web app both sync to.
- `pen-journal-YYYY-MM-DD.json`: one dated snapshot per day. These are your history if something ever goes wrong.

Ink, stickies and voice memos are all inside these files. The app uses the `drive.file` scope, so it can only see files it created, not the rest of your Drive.

When sync happens:
- about 8 seconds after you stop writing
- when you switch away from the app
- when you return to it, which pulls in edits you made on the web
- whenever you tap ☁️

Google sign-ins last about an hour. When ☁️ shows it needs you again, tap it once. If the same page was edited on both devices, the most recent edit wins.

## Hosting (needs HTTPS: GitHub Pages is easiest)

```bash
cd spen-journal
git init && git add . && git commit -m "Pen Journal"
gh repo create pen-journal --public --source . --push
gh api repos/{owner}/pen-journal/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

The app will be at `https://YOURNAME.github.io/pen-journal/`. Add `https://YOURNAME.github.io` as the authorized origin in step 4.

## Installing on the Samsung

Open the URL in **Chrome** on the phone → ⋮ → **Add to home screen → Install**. It launches full-screen like any app.

## Local testing

```bash
python -m http.server 8766
```

Then open http://localhost:8766. To test Drive sync locally, also add `http://localhost:8766` as an authorized origin.

## Updating

After changing files, bump `VERSION` in `sw.js` and the `?v=` numbers in `index.html` and `sw.js`, so phones never mix old and new files.
