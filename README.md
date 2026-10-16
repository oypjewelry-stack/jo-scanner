# OYP JO Card Scanner

A free phone web app for photographing job order cards page by page. Each photo is saved to Google Drive in **Job Order Cards / <JO#> / <JO#>-p1.jpg, -p2.jpg…**, and the JO number is OCR-checked against the number you typed.

Files: `index.html`, `style.css`, `app.js` (front end, static, no build step) and `apps-script/Code.gs` + `apps-script/appsscript.json` (backend).

## 1. Deploy the backend (Google Apps Script, free, about 5 minutes)
1. Open https://script.google.com and sign in with the Google account whose Drive should hold the cards. Click **New project** and name it "OYP JO Scanner".
2. Paste `apps-script/Code.gs` over the contents of `Code.gs`.
3. Go to **Project Settings** (gear icon) and tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` and paste in the file from this folder. That turns on the Drive API (v3) advanced service, which provides the free OCR. You can also add it by hand: **Services +**, then **Drive API**, version v3.
4. Optional security: in **Project Settings → Script Properties**, add `TOKEN` = any secret word. The phone must then send that same word.
5. Click **Deploy → New deployment**, choose type **Web app**, set *Execute as: **Me*** and *Who has access: **Anyone***, then **Deploy**. Approve the permissions; if Google shows "unverified app", choose **Advanced → Go to project**.
6. Copy the **Web app URL**. It ends in `/exec`.

After you change the code later, use **Deploy → Manage deployments → Edit → New version** so the URL stays the same.

## 2. Host the front end (free)
Any static host works. Camera access requires HTTPS.
- **GitHub Pages:** create a public repo, upload `index.html`, `style.css` and `app.js`, then go to **Settings → Pages → Deploy from branch → main / root**.
- **Cloudflare Pages:** **Workers & Pages → Create → Pages → Upload assets**, then drag in this folder.
- **Netlify Drop** (app.netlify.com/drop): drag in the folder.

## 3. Point the app at the backend
Open the page on the iPhone, tap ⚙, paste the Web app URL and the token, then tap Save. Both are stored on that phone. You can also use one link per staff phone:
`https://YOUR-SITE/?api=WEB_APP_URL&token=SECRET`

## 4. Use it
1. Type the JO number (`26-001`, `JO 26-001` and `26,001` are all accepted), then tap **Start card**. Allow camera access once. The stream stays open, so you won't be asked again for each shot or for the next card.
2. Lay the card on a **dark surface**. Once the outline turns gold and the card is held steady for about 1 second, the app snaps the page automatically. You can also tap the big button. **Crop** straightens the page; turn it off to keep the full frame.
3. Flip to the next page. Each page shows its upload status: *Saved ✓ JO verified*, *no JO read* (normal for back pages), or an amber **mismatch** warning showing the number the card actually reads. Tap **Retry** after a failed upload.
4. Tap **Done with this card**, then type the next JO number.

Tip: add the page to the Home Screen from Safari's Share menu so it opens full-screen.

## Notes
- OCR works by importing the image as a temporary Google Doc with OCR, reading the text, and trashing the doc. It is free within normal Apps Script quotas (roughly 90 minutes of run time per day on a free account; each page takes 3 to 8 seconds, so about 600 or more pages a day). Scanning 2,000 cards may take a few days, or the OCR step can be skipped.
- Shooting the same page again replaces the earlier file with the same name.
- Edge detection is a lightweight on-device brightness/contour check with no libraries, and it works best with a light card on a dark background.
