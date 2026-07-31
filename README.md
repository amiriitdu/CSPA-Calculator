# CSPA Age Calculator — put it online with GitHub Pages

Free hosting, no coding, done entirely in the browser. About 5 minutes.

## One-time setup

1. **Create a GitHub account** at github.com (free) if you don't have one.
2. Click **+** (top right) → **New repository**.
   - Repository name: `cspa-calculator`
   - Visibility: **Public** (required for free Pages hosting)
   - Click **Create repository**.
3. On the new empty repository page, click the **"uploading an existing file"** link.
4. Drag in these three files: `index.html`, `app.js`, `README.md`.
5. Click **Commit changes**.
6. Go to **Settings** (tab at the top of the repo) → **Pages** (left sidebar).
7. Under **Build and deployment → Source**, choose **Deploy from a branch**.
   Branch: **main**, folder: **/ (root)**. Click **Save**.
8. Wait about a minute, then refresh the Pages screen. Your live link appears at the top:

   `https://YOUR-USERNAME.github.io/cspa-calculator/`

9. Open it once to confirm it works, then paste that link into your WhatsApp group.

## Updating later

If the calculator is revised (for example after a USCIS policy change), just upload the new
`app.js` the same way (Add file → Upload files → commit). The link stays the same — everyone
in the group automatically gets the new version.

## What's different from the Claude version

- The live Visa Bulletin lookup is replaced with a direct link to travel.state.gov and
  instructions for reading the chart — the lookup needs Claude's AI runtime, which doesn't
  exist on a static site. Everything else (all categories, the protection window, the PDF /
  print / HTML reports, saved cases) works identically.
- Each visitor's entries are saved only in their own browser. Nothing is sent anywhere.

## The one line worth adding to your WhatsApp message

"Free estimator, not legal advice — bring the printout to an immigration lawyer."
