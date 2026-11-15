# FileSign

**Your standard client agreement, signed on every file. Automatically.**

The firm uploads the agreement every client has to sign. FileSign reads it, finds where the client needs to sign and fill in details, and works out which details the firm can fill in itself. After that, opening a file takes a client name and email. You can do it by hand, by CSV, or through the API from a case-management system. The client signs on any device without creating an account. The signed PDF, with a certificate of completion and an audit trail, goes back on the file.

- **Live app:** `<SUBMISSION URL>`
- **Repository:** `<GITHUB URL>`

---

## Trying it end to end (about 3 minutes)

1. Go to the live app and click **Get started**. Create a workspace (company name, your name, an email and a password; test data is fine).
2. **Upload the agreement** (PDF or .docx). FileSign detects the fields and opens the field editor.
   - **Blue** fields are completed by the client. **Purple** fields are filled in automatically when a file is opened (client name, file number, today's date, the firm's countersignature, and so on).
   - Drag fields to move them, use the corner handle to resize, or add fields with the palette. Select a field to change its type, who completes it, or what fills it.
3. Click **Save & open a file →**. Enter a client name and email, then click **Send for signature**.
4. On the file page, click **Open** next to the signing link. This is the client's view, so you can try it on a phone too.
5. Agree to sign electronically. Then click **Start** / **Next**, which takes you through every required field. Adopt a typed or drawn signature and click **Finish → Sign agreement**.
6. Download the signed PDF. Back on the file page, the status is **Signed** and the audit trail is complete. You can upload the signed PDF at **/verify** to confirm it hasn't been changed.

> **Email:** the live instance has no outbound email configured (see "Assumptions"), so the sender shares the signing link themselves. That is also what lets a reviewer finish the whole flow without real inboxes. Setting `SMTP_URL` turns on request, reminder, completion and decline emails with the signed PDF attached, and nothing else changes.

---

## What I built

A multi-tenant web product that a company in this industry could sign up for and use the same day:

| Area | What it does |
|---|---|
| **Agreement setup** | Upload a PDF or Word file. Fields are detected automatically. If detection gets something wrong, a drag-and-drop editor fixes it. You can keep several agreements and mark one as the default. |
| **Opening a file** | Single-client form, bulk CSV paste, or `POST /api/files`. The file number is generated automatically if you leave it blank. |
| **Client signing** | No account needed. ESIGN/UETA consent, a guided "Next field" flow, typed or drawn signature and initials adopted once and reused, date filled by the server, decline with a reason. Works on mobile. |
| **Completion** | The signed PDF is flattened, every page is stamped with the envelope ID, and a certificate of completion is appended. It records document hashes, signer IP and device, consent time, the adopted signature and the full event history. |
| **Tracking** | Dashboard of every file by status (waiting, opened, signed, declined, expired, voided), search, average time to sign, a per-file audit trail, reminders, void. |
| **Automation** | REST API with a workspace API key. HMAC-signed webhooks for `file.sent/viewed/completed/declined/voided`. Automatic reminders. Links expire. |
| **Trust** | SHA-256 fingerprint of the document as sent and as signed. Anyone can run a public tamper check at `/verify`. |
| **Team** | Workspace per company, admins and members, API key rotation, settings for company name, reply-to address, reminder interval and link expiry. |

### How it handles an agreement it has never seen

This was the hard requirement, so it gets most of the engineering. See [src/pdf.js](src/pdf.js).

1. **Normalise.** PDFs are validated (password-protected files get a clear error). Word files are converted to a clean PDF, and their tables are kept as real columns so side-by-side signature blocks stay apart.
2. **Read the layout.** pdf.js pulls every text run with its position. Runs are grouped into lines, and sub-run positions are worked out from glyph widths rather than character counts.
3. **Detect fields.** Three detectors run together:
   - **Placeholders** such as `[Client Name]`, `{{matter_number}}` and `<<Date>>` become fields that are filled in automatically, mapped to client name, client email, file number or today's date where the label makes that clear. Anything else is asked of the sender when they open a file. The placeholder text is covered and replaced, not overlapped. `[ ]` becomes a checkbox.
   - **Blank lines** (`______`) are classified from the label beside them ("Signature:", "Date", "Print name", "Initials", and so on) or from a caption underneath the line.
   - **Bare labels** such as `Signature:` with nothing after them get a field placed to the right.
4. **Work out whose line it is.** The nearest heading above each line, in the same column, decides whether it belongs to the client ("Client", "Customer", "Claimant", …) or to the firm ("Company", "Provider", "Attorney", … plus the workspace's own company name). Firm-side lines are countersigned automatically with the sender's name and date when the file is opened.
5. **Fallback.** If no client signature line is found (a scanned PDF, or an agreement with no signature block), FileSign **adds a signature page** with signature, name and date. Any agreement can be executed.
6. **Human check.** The editor shows exactly what was detected, and why, before anything is sent.

---

## Features included, and why

- **Upload once, reuse on every file (templates + default agreement).** The client's problem is the *same* agreement on *every* file. Setup happens once. After that, each file is just a name and an email.
- **Automatic field detection plus an editor to correct it.** Reviewers will use an agreement I haven't seen, and so will every future customer. Detection makes setup fast. The editor means detection doesn't have to be perfect.
- **Signature-page fallback.** It guarantees that *any* document can be signed, including scans and agreements with no signature block.
- **Auto-filled fields and firm countersignature.** Typing the client's name, file number and date into the agreement is part of the manual work the client complained about. Most agreements have a firm signature block too, and leaving it blank would make the result incomplete.
- **Client signing with no account, mobile first.** Every extra step for the client delays the file. Most clients will open the link on a phone.
- **ESIGN/UETA consent, audit trail, certificate, hashes, `/verify`.** An e-signature product is only worth buying if the signature holds up when it's challenged. These are the things a lawyer or insurer would ask for.
- **Server-controlled signing date.** The client can't backdate the agreement.
- **Status dashboard, reminders, expiry, void, decline with a reason.** "Slows down every file" is really about not knowing what's outstanding and chasing it. Declines with a reason tell the firm what to fix.
- **API, webhooks and bulk CSV.** The client said "automates getting that agreement signed **on every file**". Real automation means no one has to open FileSign at all: the case-management system creates the file, and the signed agreement comes back to it through a webhook.
- **Multi-tenant workspaces, teams and settings.** The client wants to *sell this to every other company in the industry*, so it has to be self-serve and isolated per company from day one. Every query is scoped to the workspace.
- **Works without email configured.** The flow never depends on a mail provider. The sender can always copy the link into their own email, text or client portal.

## Features deliberately left out, and why

- **Billing and subscriptions (Stripe).** It doesn't help get an agreement signed, and pricing is a business decision to make with the first customers. It's straightforward to add once there is a price.
- **Multiple client signers and signing order.** The brief says each file is one job for *one client*. One client signer, plus the firm countersigning automatically, covers that. Routing order adds a lot of UI and state for a case the brief doesn't describe.
- **Identity verification (SMS codes, ID or KBA checks).** It adds cost and friction for every client. Email-link authentication, IP and device capture and consent records are the standard for client engagement agreements. It's the first thing I'd add for regulated customers who need it.
- **Document generation / clause editing.** The firm already has *its* agreement. FileSign fills fields; it doesn't draft or redline contracts.
- **SSO/SAML, audit-log export, data-residency options.** These are enterprise purchase requirements.
- **Certificate-based (PAdES) digital signatures.** Under ESIGN/UETA, an electronic signature with an audit trail is legally sufficient for these agreements. PKI signing needs a CA-issued certificate and key management. Tamper evidence is covered by the SHA-256 records and `/verify`.
- **Password reset and email verification on signup.** Both need outbound email, which the demo instance doesn't have. Admins can add teammates with temporary passwords.
- **Pixel-perfect Word rendering.** Word files are converted to a clean PDF that keeps text, headings, lists and tables but not exact styling. Firms that care about layout can upload the PDF export of their Word file, and that is the recommended path. Full fidelity would need LibreOffice in the container, which roughly triples the image size.

---

## Assumptions and decisions

- **"Agreement" means one standard document per company,** filled in per file, not a different contract each time. Several templates are supported anyway.
- **The client is the only party who signs through a link.** Firm-side fields are completed at send time by whoever opens the file. That is recorded in the audit trail as a countersignature.
- **Email is optional infrastructure.** The submission instance runs without SMTP so reviewers can complete the flow in one browser. With `SMTP_URL` set, every email path (request, reminder, completion with the PDF attached, decline) is live.
- **Test data only.** The sample agreements in `samples/` use fictional companies and people.
- **Rotated pages** are flagged in the editor, because field placement assumes upright pages.

## Running it

```bash
npm install
npm start                    # http://localhost:3000
npm run samples              # generate fictional test agreements in samples/
node scripts/detect.js samples/two-party-agreement.pdf "Northwind Advisory"   # see what detection finds
npm test                     # end-to-end API test against a running server
```

Environment variables: `PORT`, `DATA_DIR` (database and documents, default `./data`), `APP_URL` (public base URL for links in emails and reminders), `SMTP_URL` or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, `MAIL_FROM`.

**Deploy:** `Dockerfile` and a Render blueprint (`render.yaml`) are included. Mount a persistent volume at `DATA_DIR`.

## Architecture

- **Node.js + Express**, one service. **SQLite** through Node's built-in `node:sqlite`, so there's no native build and no external database to run. Documents are stored on disk next to it.
- **pdf.js** for text and layout extraction (server) and rendering (browser). **pdf-lib** for stamping, flattening and certificates. **mammoth** for Word conversion. **nodemailer** for SMTP.
- Plain HTML, CSS and ES modules in the browser, with no build step.
- Security: scrypt password hashing, HTTP-only SameSite session cookies, 256-bit random signing tokens, workspace-scoped queries, login throttling, HMAC-signed webhooks, input validation on every field value, and a guard against double submission.

Scaling path: swap SQLite for Postgres and local disk for S3 behind the same two modules (`src/db.js`, file read/write helpers in `src/server.js`).

## Tools used

Node.js 24, Express, pdf.js, pdf-lib, mammoth, nodemailer, SQLite (`node:sqlite`). Playwright and PyMuPDF were used for automated browser testing and checking the rendered output. Built with Claude Code (Anthropic) as an AI pair programmer.
