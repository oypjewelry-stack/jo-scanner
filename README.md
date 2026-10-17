# OYP Card Scanner

A free phone web app for photographing job order cards page by page. Each photo is saved to Google Drive in **Job Order Cards / <JO#> / <JO#>-p1.jpg, -p2.jpg…**, and the JO number is OCR-checked against the number you typed.

Files: `index.html`, `style.css`, `app.js` (front end, static, no build step) and `apps-script/Code.gs` + `apps-script/appsscript.json` (backend).

## 1. Deploy the backend (Google Apps Script, free, about 5 minutes)
1. Open https://script.google.com and sign in with the Google account whose Drive should hold the cards. Click **New project** and name it "OYP JO Scanner".
2. Paste `apps-script/Code.gs` over the contents of `Code.gs`.
3. Go to **Project Settings** (settings (⋯) icon) and tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` and paste in the file from this folder. That turns on the Drive API (v3) advanced service, which provides the free OCR. You can also add it by hand: **Services +**, then **Drive API**, version v3.
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
Open the page on the iPhone, tap Settings, paste the Web app URL and the token, then tap Save. Both are stored on that phone. You can also use one link per staff phone:
`https://YOUR-SITE/?api=WEB_APP_URL&token=SECRET`

## 4. Use it
1. Type the JO number (`26-001`, `JO 26-001` and `26,001` are all accepted), then tap **SCAN**. Allow camera access once. The stream stays open, so you won't be asked again for each shot or for the next card.
2. Lay the card on a **dark surface**. Once the outline turns gold and the card is held steady for about 1 second, the app snaps the page automatically. You can also tap the big button. **Crop** straightens the page; turn it off to keep the full frame.
3. Flip to the next page. Each page shows its upload status: *Saved ✓ JO verified*, *no JO read* (normal for back pages), or an amber **mismatch** warning showing the number the card actually reads. Tap **Retry** after a failed upload.
4. Tap **Done with this card**, then type the next JO number.

Tip: add the page to the Home Screen from Safari's Share menu so it opens full-screen.

## Notes
- OCR works by importing the image as a temporary Google Doc with OCR, reading the text, and trashing the doc. It is free within normal Apps Script quotas (roughly 90 minutes of run time per day on a free account; each page takes 3 to 8 seconds, so about 600 or more pages a day). Scanning 2,000 cards may take a few days, or the OCR step can be skipped.
- Shooting the same page again replaces the earlier file with the same name.
- Edge detection is a lightweight on-device brightness/contour check with no libraries, and it works best with a light card on a dark background.

## Voice input
Tap the gold mic button beside the JO box and say the number ("twenty six zero zero one", "two six oh oh one", "JO 26 001"). It fills in `26-001` (short forms like "26 1" become `26-001`) and always starts scanning; the camera is opened during the mic tap so iOS allows it. If the browser lacks speech recognition the button is hidden; keyboard dictation still works.

## Card detection (v2)
- Detection uses OpenCV.js (loaded from jsDelivr after the page opens; "Loading detector…" shows until ready). It tries Canny edges, brightness/saturation thresholds and adaptive threshold on a 480px frame, keeps the best 4-corner shape, smooths it across frames, and auto-snaps after ~0.8 s steady.
- After every capture a review screen opens: drag the 4 gold corners to fit the card, then **Use**, **No crop** (keep full photo) or **Retake**.
- If no card is found, tap the shutter: the full photo opens in the corner editor with a default rectangle.
- Tips: a darker or plain surface under the card, and no other sheets touching it, gives the best auto-crop.

## Sign-in backend (Auth.gs) — one-time update
1. In the Apps Script project, add a new script file named `Auth` and paste `apps-script/Auth.gs`. Replace `Code.gs` and `appsscript.json` with the versions here (adds the Sheets scope).
2. Optional: Project Settings → Script Properties → `SHEET_ID` = the id of the Sheet to use. If unset, a new "OYP JO System" spreadsheet is created in your Drive. Only the tabs Users, Sessions and AuditLog are added; nothing else is changed.
3. Add Script Property `SEED_USERS` = `name:role:code,...` (sent privately). Select `setupAuth` in the editor and click **Run**, approve the new permission. It seeds the users (hashes only) and deletes `SEED_USERS`.
4. **Deploy → Manage deployments → Edit → New version → Deploy** (keeps the same URL).

## Customer portal + shop backend (Customers.gs) — one-time update
Do this after the sign-in update above (it needs `Auth.gs`).
1. In the Apps Script project, add a new script file named `Customers` and paste `apps-script/Customers.gs`.
2. Replace `Auth.gs` with the version here. The only change is one line near the top of `handleAction_`:
   `if (typeof handleCustomer_ === 'function' && isCustAction_(a)) return handleCustomer_(req); // Customers.gs`
   (If you already pasted Auth.gs, just add that line right after `var a = req.action;`.)
3. Select `setupCustomers` in the editor and click **Run**. Approve the new **Send email as you** permission (used only for the
   6-digit sign-up and Forgot PIN codes a customer asks for). It adds four new tabs: Customers, CustomerSessions, CustomerLinks,
   ShopItems. Existing tabs (Clients, JobOrders, Payments, Quotes, JobStages) are only read, never changed.
4. **Deploy → Manage deployments → Edit → New version → Deploy** (same URL).

Links: customers `https://oypjewelry-stack.github.io/oyp/my/`, shop `https://oypjewelry-stack.github.io/oyp/shop/`,
admin screens in the back office under **Customers** and **Shop listings**.
Email limit: Gmail allows about 100 automatic emails a day; the script caps itself at 80 codes/day, 3 per email per hour.

## Scans -> Sheet (JobSync.gs) — one-time update
1. Add a new **Script** file named `JobSync` and paste `apps-script/JobSync.gs`.
2. In `Auth.gs` `handleAction_`, right after the `dashboard` line, add:
   `if (typeof isJobAction_ === 'function' && isJobAction_(a)) return handleJob_(req, s.user); // JobSync.gs`
   In `Code.gs` `doPost`, right after the line `var found = findJOs_(ocrText);`, add:
   `var job = typeof recordScan_ === 'function' ? recordScan_(req, jo, file, folder, ocrText, found, ocrError) : null; // JobSync.gs`
3. Select `setupJobs` and click **Run**. It only ADDS the tabs JobOrders, JobStages, Clients, OcrLog (existing tabs are left as they are).
4. Replace `Dashboard.gs` with the version here (location counts; only "Being worked on" JOs on the board).
5. Optional: run `importExistingScans` (again until the log says Done) for cards scanned before this update.
6. **Deploy → Manage deployments → Edit → New version → Deploy**.
Back office **To review** (admin + production manager): card photos (served by the script, Drive files stay private), location picker,
quick edit, bulk "set location". Each uploaded page then adds an OcrLog row; the first scan of a JO adds a draft JobOrders row + its first stage. Re-scans never
duplicate and only fill blank cells (overwrite needs `overwrite:true`). Until setupJobs is run, scans work exactly as before.

## Cost estimator (Costing.gs)
1. Apps Script → **+ → Script** → name it `Costing` → paste `apps-script/Costing.gs` → Save. (Needs JobSync.gs from the pricing update.)
2. In **Auth.gs**, right under the `// JobSync.gs` line in `handleAction_`, add:
   `if (typeof isCostAction_ === 'function' && isCostAction_(a)) return handleCost_(req, s.user); // Costing.gs`
3. Pick `setupCosting` in the function menu → **Run** once. It adds the **Rates** and **Quotes** tabs (if missing) and fills Rates from the costing sheet. Running it again changes nothing.
4. **Deploy → Manage deployments → Edit → New version → Deploy.**
Rates can be edited in the Rates tab (column `rate`). Markup rows (category `markup`) are only ever sent to executives (Script Property `EXEC_ROLES`, default `admin`).
Saved quotes are status `draft`; customers only ever see quotes marked `sent` or `accepted`.
