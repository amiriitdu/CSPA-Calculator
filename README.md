# CSPA Age Calculator — a public link for visitors, via GitHub Pages

Free hosting, no coding. A GitHub Actions workflow
(`.github/workflows/deploy-pages.yml`) builds and publishes the public link
automatically every time `main` changes — there's nothing to re-upload by hand.

## One-time setup

1. **Create a GitHub account** at github.com (free) if you don't have one.
2. Push (or upload) this repository's files — `index.html`, `app.js`, `README.md`,
   and the `.github/workflows/deploy-pages.yml` workflow — to a **public** repository
   on GitHub (required for free Pages hosting).
3. Go to **Settings** (tab at the top of the repo) → **Pages** (left sidebar).
4. Under **Build and deployment → Source**, choose **GitHub Actions**.
5. Go to the **Actions** tab and confirm the "Deploy public visitor link (GitHub Pages)"
   workflow has run (it runs automatically on every push to `main`, or trigger it
   manually with **Run workflow**).
6. Once it finishes, your live link appears on the **Settings → Pages** screen:

   `https://YOUR-USERNAME.github.io/YOUR-REPO-NAME/`

7. Open it once to confirm it works, then paste that link into your WhatsApp group.

## Updating later

If the calculator is revised (for example after a USCIS policy change), just push the
updated `app.js` to `main`. The workflow rebuilds and republishes automatically — the
link stays the same, and everyone in the group gets the new version within a minute or
two.

## What's different from the Claude version

- The live Visa Bulletin lookup is replaced with a direct link to travel.state.gov and
  instructions for reading the chart — the lookup needs Claude's AI runtime, which doesn't
  exist on a static site. Everything else (all categories, the protection window, the PDF /
  print / HTML reports, saved cases) works identically.
- Each visitor's entries are saved only in their own browser. Nothing is sent anywhere.

## The one line worth adding to your WhatsApp message

"Free estimator, not legal advice — bring the printout to an immigration lawyer."
