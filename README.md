# PeraPilot — Take control of your money.

Personal finance web app na naka-base sa **actual na sweldo (payday) at cut-off** mo.
Plain HTML + CSS + JavaScript. Walang build step, walang account, walang cloud. Lahat ng data ay naka-save sa device mo (IndexedDB).

---

## 1. Paano patakbuhin

### Pinakamadali
I-double-click ang **`index.html`**. Bubukas sa browser (Chrome / Edge / Firefox). May demo data na agad para ma-test mo.

> Sa unang bukas, may **demo data**. Pindutin ang **"Clear demo & start fresh"** sa taas para ilagay ang sarili mong data.

### Mas maganda (kailangan para sa install bilang app at offline)
Mag-run ng maliit na local server sa loob ng folder na ito:

```bash
python3 -m http.server 8080
# tapos buksan: http://localhost:8080
```

(o `npx serve .`, o kahit anong static host)

Mahalaga: **magkahiwalay ang data** kapag binuksan via `file://` at via `http://localhost:8080` (magkaiba ang "origin" ng browser). Piliin ang isang paraan at doon na manatili, o gamitin ang **Settings → Download backup / Restore backup** para ilipat.

### I-install sa Android (PWA)
Kailangan i-host ito sa **https** (o `localhost`). Kapag nabuksan sa Chrome para sa Android: menu ⋮ → **Install app** / **Add to Home screen**. Handa na ang `manifest.webmanifest`, `sw.js` (offline), at ang mga icon sa `icons/`.

---

## 2. Mga file

```
index.html            ang app shell
style.css             navy / teal / gold design, responsive (mobile-first)
app.js                router, mga page, mga form (UI lang — walang financial rules dito)
js/logic.js           LAHAT ng financial rules (puro functions, walang DOM, testable)
js/db.js              IndexedDB persistence (atomic na save), backup/restore
js/demo.js            realistic na demo data (laging naka-base sa petsa ngayon)
js/ui.js              modals, confirm dialogs, form helpers
manifest.webmanifest  PWA manifest
sw.js                 service worker (offline)
icons/                192, 512, maskable 512
tests/                automated tests (tingnan ang #6)
```

---

## 3. Paano naka-store ang data

- **Pera = integer centavos** (₱1.00 = 100). Walang floating-point error.
- **Ang transactions ang tanging source of truth.** Ang balance ng wallet, ipon sa goal, at natitirang utang ay **kino-compute** mula sa transactions — hindi naka-save na numero. Kaya kapag nag-edit o nag-delete ka, imposibleng may duplicate o hindi tugma.
- Mga store: `wallets`, `transactions`, `goals`, `bills`, `debts`, `budgetCategories`, `allocations`, `weekClosures`, `meta` (settings).
- Bawat aksyon ay isang **atomic** na IndexedDB transaction — kung mag-refresh o mag-crash sa gitna, walang kalahating-save na transfer.
- Bago mag-save, sinusuri ng ledger: walang wallet na bababa sa ₱0, walang goal na negatibo, walang utang na sobra ang bayad.

## 4. Mga financial rule (at kung saan sila naka-implement)

| Rule | Paano |
|---|---|
| Expected payday ay **info lang** | Hindi gumagawa ng income, cut-off, o reset. Kino-compute lang ito mula sa schedule (default 15 at 30, mababago sa Settings). |
| Cut-off nagsisimula **lang** kapag may **na-record na salary na natanggap** | Ang cut-off ay galing sa salary transaction. Expected Nov 15, natanggap Nov 17 → **nagsisimula ng Nov 17**. |
| Pag nag-record ng salary | Income na-record · tinatanong kung anong wallet · bagong cut-off · nagre-reset ang cut-off summaries · puwedeng i-plan ang allocation. Nananatili ang lumang history. |
| Salary allocation = **plano lang** | Default 30/10/10/40/10, editable (% o halaga). Laging may "totals 100%" na indicator. **Hindi kailanman gumagalaw ng wallet.** May "Planned vs actual". |
| Total Balance | Active wallets lang. **Hindi kasama ang savings goals.** |
| Safe to Spend | Total Balance − bills na di pa bayad bago ang susunod na payday − planned goals/tithes na di pa nailalaan; may cap na natitirang planned Variable budget kung may plan. Daily guide = Safe to Spend ÷ araw bago payday. |
| Weekly budget | 7 araw bawat linggo mula sa araw ng cut-off. Expense bumababa lang sa budget category kung **tugma ang category**. Bills, utang, at ipon **hindi** bumababa. **Walang auto carry-over** — ikaw ang magpapasya (savings / next week / split / unassigned). |
| Savings contribution | Bawas sa wallet, dagdag sa goal. **Hindi expense.** |
| Transfer | Wallet → wallet. **Hindi income o expense.** Kailangan ng purpose/note. |
| Bills | Buwanan (hindi per cut-off). Manual na "Mark paid". Walang auto-deduct. Babalik na pending sa susunod na buwan. May payment history at Undo. |
| Debts | Flexible na bayad, hindi nagre-reset kada cut-off, "Paid off" kapag zero. Walang auto-bayad. |
| Wallet delete | May laman o may history = hindi mabubura. May balance → kailangan munang i-transfer. May history lang → **i-archive** (nananatili ang history). |

## 5. Mga desisyong ginawa ko (puwede nating baguhin)

1. **Hindi puwedeng negatibo ang wallet** — tinatanggihan ang gastos na lalampas sa laman.
2. **Debt payments ay kasama sa "Expenses"** ng cut-off (may breakdown: Spending / Bills / Debt), pero hindi sa weekly variable budget.
3. **Safe to Spend** formula sa itaas (hindi nire-reserve ang utang kasi wala itong fixed na hulog).
4. Ang "Fixed Expenses" sa Planned vs Actual = bills + debt payments; "Goal Funds" = net savings; "Tithes" = expense na category na *Offering / Tithes*.
5. Ang pagbago ng weekly amount ng isang category ay **nag-a-apply mula sa kasalukuyang linggo**; hindi nababago ang mga lumipas na linggo.
6. Hindi puwedeng i-future-date ang transaction o salary.

## 6. Tests

```bash
cd tests
node --test logic.test.js     # 22 tests ng financial logic (Node 18+, walang dependency)
```

Browser tests (kailangan ng `npm i playwright` at server na nakabukas sa port 8765):

```bash
python3 -m http.server 8765 &      # mula sa root folder
node tests/e2e.js                  # 115 checks sa totoong Chromium (PP_URL=http://localhost:PORT/index.html kung iba ang port)
node tests/smoke.js                # bawat page, desktop + mobile, console errors
node tests/overflow.js             # horizontal overflow check sa mobile
```

Saklaw ng `e2e.js`: navigation, salary + cut-off (Nov 15 expected / Nov 17 received), allocation, wallets, transfers, savings, bills (kasama ang buwan-buwan na pagbalik), debts, weekly budget, validation, double-click protection, persistence pagkatapos ng refresh at sa bagong tab, reports, settings, backup, at mobile layout.

## 7. Mga limitasyon (v1)

- **Walang cloud backup / sync / login** (sinadya). Kapag nabura ang browser data, mawawala ang data — gamitin ang **Settings → Download backup** paminsan-minsan.
- Para sa **iisang device** bawat data set. (Kapag may dalawang tab, nagre-refresh ng data pag bumalik ka sa tab.)
- Ang date picker ay sumusunod sa locale ng device (sa Philippine na Android, dd/mm/yyyy ang karaniwan). Ang mga petsang ipinapakita ng app ay naka-format na `Nov 17, 2026`.
- Na-test sa Chromium (desktop at mobile emulation). **Hindi pa na-test sa totoong Android phone.**
- Piso lang (₱).
