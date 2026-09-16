# Certification guide: Microsoft and Apple

What it takes to get Phorma Agent Studio "certified" by Microsoft and Apple - meaning installers that
pass SmartScreen on Windows and Gatekeeper on macOS without warnings, plus the optional store paths
and what they would require.

This guide is grounded in the current release pipeline (`.github/workflows/release.yml`,
`backend/src-tauri/tauri.conf.json`). The workflow already has commented-out env blocks for both
signing paths; this document is the path to turning them on.

---

## 1. What "certified" means for this app

Phorma Agent Studio is a Tauri v2 desktop app distributed **directly** (GitHub Releases + R2 + in-app
updater), not through an app store. For direct distribution, certification means:

| Platform | The gate | What clears it |
|---|---|---|
| Windows | **SmartScreen**: unsigned or unknown installers show "Windows protected your PC" | Code signing with a publicly trusted certificate (Azure Trusted Signing) |
| macOS | **Gatekeeper**: since macOS Catalina (10.15), anything distributed outside the App Store MUST be notarized or users get "app is damaged / cannot be opened" | Developer ID signing + notarization via Apple |

Two things are already in place and are NOT part of this work:

- **Updater integrity**: the Tauri minisign keypair (`backend/src-tauri/.tauri/updater.key`, wired via
  `TAURI_SIGNING_PRIVATE_KEY` secrets) already signs updater artifacts. That proves update
  authenticity to the app itself; it does nothing for OS-level trust.
- **TLS**: all cloud endpoints are HTTPS. Notarization and SmartScreen do not inspect this.

What is missing is **OS code signing** on both platforms. That requires paid accounts and identity
validation, which is why the workflow ships with those env blocks commented out.

### Why not the app stores (short answer)

- **Mac App Store**: requires App Sandbox. Tauri apps are not sandboxed, and this app's core value
  (local Rust LLM proxy, OS keychain access, arbitrary MCP servers, direct database connections)
  is fundamentally incompatible with sandboxing. Not viable without a rewrite. Every serious
  pro desktop tool (VS Code, n8n desktop, Postgres clients) distributes via Developer ID instead.
- **Microsoft Store**: technically possible later (MSIX repackaging), but it adds Store policy
  review, a separate update channel that would fight the in-app updater, and no real benefit for a
  pro tool users download from the site. Revisit only if enterprise distribution demands it.

The recommended path is: **sign + notarize for direct distribution** on both platforms. That is what
the rest of this guide covers, with the store paths summarized at the end for completeness.

---

## 2. Current state in this repo

| Item | Status |
|---|---|
| Windows target | NSIS installer, `installMode: currentUser` (no admin needed - good) |
| macOS targets | `.app` + `.dmg`, arm64 and x64, built on `macos-latest` runners |
| Updater signing | Done (minisign keypair, CI secrets set) |
| Windows code signing | **Not present** - `AZURE_TRUSTED_SIGNING_*` block commented out in `release.yml` |
| macOS signing + notarization | **Not present** - `APPLE_*` block commented out in `release.yml` |
| Apple Developer Program membership | Not enrolled |
| Azure Trusted Signing account | Not provisioned |

Known gotcha (already documented in
`.github/skills/release-playbook/references/failure-modes.md`): a defined-but-empty
`APPLE_CERTIFICATE` makes Tauri attempt signing with garbage and fails in `SecKeychainItemImport`.
The env blocks must stay commented out until real values exist - do not "prepare" them with empty
secrets.

---

## 3. Apple path: Developer ID + notarization

### 3.1 What is involved

1. **Apple Developer Program membership** (organization type, under the Phorma legal entity).
2. A **Developer ID Application** certificate (created once, exported as `.p12`).
3. CI signs the `.app` with `codesign` (hardened runtime), then submits the `.dmg`/`.app` to
   **notarytool** for notarization, then staples the ticket.
4. `tauri-action` does all of steps 3 automatically when the `APPLE_*` env vars are present.

### 3.2 Enrollment

- **Cost: $99 USD per year**, renewed annually. Notarization itself is free and unlimited.
- Organization enrollment requires a **DUNS number** for the legal entity. If Phorma does not have
  one, requesting it from Dun & Bradstreet takes up to ~2 weeks; if one exists, enrollment is
  usually 1-2 days.
- Individual enrollment is instant but puts a personal name on the certificate - avoid for a
  product company.
- Requires two-factor authentication on the Apple ID and acceptance of the Developer Program
  License Agreement.

### 3.3 Creating the signing certificate (one-time, needs a Mac)

1. On any Mac, open Keychain Access and generate a Certificate Signing Request (CSR).
2. In the Apple Developer portal, create a **Developer ID Application** certificate from that CSR.
3. Download the `.cer`, add it to Keychain Access (it pairs with the CSR's private key).
4. Export the key + certificate as a `.p12` with a password.
5. Base64-encode the `.p12` for the GitHub secret:
   `base64 -i developer-id.p12 | pbcopy` (macOS) or `certutil -encode` on Windows.

The `.p12` is a signing credential - treat it like the updater private key. Store it only as a
GitHub Actions secret (and a password manager), never in the repo.

### 3.4 CI wiring

Uncomment the macOS block in `.github/workflows/release.yml` and set these repository secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | the Apple ID email of a team member |
| `APPLE_PASSWORD` | an **app-specific password** created at appleid.apple.com (NOT the Apple ID password) |
| `APPLE_TEAM_ID` | 10-character team ID from the membership page |

`tauri-action` then, per build: signs the app bundle with the hardened runtime, signs the DMG,
submits to notarization, staples, and attaches the notarized artifacts to the GitHub Release. No
workflow logic changes needed beyond uncommenting.

Notes:

- Both macOS targets (arm64 + x64) sign with the same certificate; the matrix already builds both.
- Notarization adds roughly 5-15 minutes per target to the release build.
- If notarization is ever rejected, the reason comes back in the notary log; common causes are
  unsigned nested binaries or missing hardened runtime. Tauri handles both by default, so first
  attempts usually pass.

### 3.5 Timeline and cost

| Item | Cost | Elapsed time |
|---|---|---|
| DUNS number (if missing) | Free | up to 2 weeks |
| Apple Developer Program (org) | $99/year | 1-2 days after DUNS |
| Developer ID cert + secrets setup | Free | half a day |
| First signed + notarized release | Free | one release cycle |

### 3.6 Detailed walkthrough: Apple, step by step (no technical background assumed)

This subsection spells out every click for sections 3.2-3.4 above. Read it once end to end before
starting so you know what is coming. Total active effort is a few hours spread over several weeks;
most of the wait is Dun & Bradstreet and Apple verifying the company. Steps 1-8 are administrative
- anyone at the company can do them. Only step 9 needs an engineer.

#### What you need before you start

- The company's exact legal name, registered address, and main phone number as they appear on
  official paperwork.
- A company email address you control (for example, you@phorma.com).
- A credit card for the $99 annual fee.
- Occasional access to any Mac (borrowed is fine) for about 30 minutes during step 4.

#### Step 1: Find out whether the company already has a DUNS number

A DUNS number is a 9-digit ID that Dun & Bradstreet (a business registry agency) assigns to
companies. Apple uses it to confirm the company is real before allowing enrollment.

1. Ask your accountant or bookkeeper whether the company has one - many companies receive one
   automatically when they open a business bank account or take out credit.
2. If nobody knows, search for the company at https://www.dnb.com/duns-number/lookup.html (free).
3. If the company has one, write it down and skip to step 3.

#### Step 2: Request a DUNS number (only if missing)

1. Go to https://www.dnb.com/duns-number/get-a-duns/ and choose the free option for companies
   seeking to register with Apple or a government agency. Do not pay for expedited service.
2. Fill in the legal business name, headquarters address, a phone number that reaches the
   company, and the name of an owner or company officer.
3. Submit and wait. This is the slowest part of the whole Apple process - usually about 2 weeks,
   occasionally up to 30 days. The number arrives by email.

#### Step 3: Enroll in the Apple Developer Program

1. Go to https://developer.apple.com/programs/ and click Enroll.
2. Sign in with an Apple ID. If the company does not have a shared one, create a new Apple ID at
   https://appleid.apple.com using a company email address (not a personal Gmail). This Apple ID
   will own the company's certificates, so use an address that will outlive any single employee.
3. Turn on two-factor authentication for that Apple ID (Apple requires it): on an iPhone or iPad
   go to Settings > your name > Sign-In & Security > Two-Factor Authentication, or follow the
   prompts at appleid.apple.com.
4. Choose "Company / Organization" as the enrollment type. Do NOT choose "Individual" - that puts
   a personal name on the app's signature instead of the company's.
5. Enter the DUNS number, legal entity name, and address exactly as they appear in the Dun &
   Bradstreet record. Mismatches are the most common cause of rejection.
6. Apple may phone the company's main number to verify you have authority to enroll the company.
   Tell whoever answers reception to expect a call from Apple.
7. When the approval email arrives, pay the $99 annual fee online.

#### Step 4: Create the signing certificate (needs a Mac for about 30 minutes)

Think of the certificate as a digital ID card that gets attached to the app so macOS knows who
published it. You create it once and reuse it forever. You must be signed in to the developer
portal as the Account Holder (the person who enrolled in step 3).

1. On any Mac, open the built-in "Keychain Access" app (press Cmd+Space, type "Keychain Access").
2. In the menu bar: Keychain Access > Certificate Assistant > Request a Certificate from a
   Certificate Authority...
3. Enter your email address, any "Common Name" (the company name is fine), leave "Saved to disk"
   selected, and save the file it creates. This file is called a CSR - it is a request, not the
   certificate itself.
4. Go to https://developer.apple.com/account and sign in with the company Apple ID.
5. In the sidebar under "Certificates, Identifiers & Profiles", click Certificates, then the +
   button.
6. Choose "Developer ID Application" from the list (NOT "Developer ID Installer") and continue.
7. Upload the CSR file you saved, continue, and download the certificate it produces (a .cer
   file).
8. Double-click the downloaded .cer file. The Mac adds it to the keychain and pairs it with the
   request you made earlier.
9. Back in Keychain Access, click "My Certificates" in the sidebar, find the "Developer ID
   Application" entry, click the small triangle to expand it, then hold Cmd and click BOTH the
   certificate and the "private key" line underneath it.
10. Right-click and choose "Export 2 items...". Choose file format "Personal Information Exchange
    (.p12)", save it, and set a password when asked. Write this password down - it is needed later
    and cannot be recovered.

The .p12 file you just made is the company's signing credential. Treat it like a company seal:
anyone holding it can sign apps as the company. Store it in a password manager, never email it,
never put it in the repo.

#### Step 5: Create an "app-specific password" for the notarization service

Apple's automated notarization service refuses your normal Apple ID password; it insists on a
single-purpose password you create just for it.

1. Go to https://appleid.apple.com and sign in with the company Apple ID.
2. Under "Sign-In and Security", click "App-Specific Passwords", then the generate/+ link.
3. Name it something like "Phorma release notarization" and click Create.
4. Copy the password it shows (it looks like abcd-efgh-ijkl-mnop). You cannot view it again later.

#### Step 6: Find the Team ID

1. Go to https://developer.apple.com/account and click "Membership" in the sidebar.
2. Copy the "Team ID" - a 10-character code of letters and numbers.

#### Step 7: Convert the .p12 file into text

GitHub's secret storage only accepts text, so the certificate file must be turned into a long
block of text first.

- On the Mac: open Terminal (Cmd+Space, type "Terminal") and run
  `base64 -i ~/Desktop/developer-id.p12 | pbcopy` (adjust the path to wherever the .p12 is). The
  text version is now on the clipboard, ready to paste.
- On Windows: open Command Prompt and run `certutil -encode developer-id.p12 out.txt`, then open
  out.txt in Notepad and delete the BEGIN/END lines so only the middle block remains.

#### Step 8: Put the five values into GitHub

1. Open the phorma-agent-studio repository on github.com while signed in as a repository
   administrator.
2. Click Settings > Secrets and variables > Actions > "New repository secret".
3. Create these five, one at a time:
   - `APPLE_CERTIFICATE` - the long text block from step 7
   - `APPLE_CERTIFICATE_PASSWORD` - the password you set when exporting the .p12
   - `APPLE_ID` - the company Apple ID email address
   - `APPLE_PASSWORD` - the app-specific password from step 5
   - `APPLE_TEAM_ID` - the 10-character Team ID from step 6

#### Step 9: Hand off to engineering

Everything above is administrative. The final step - uncommenting the macOS block in the release
workflow and cutting a test release - is a short engineering task covered in section 3.4 and
step 5 of the execution plan (section 6).

---

## 4. Microsoft path: Azure Trusted Signing

### 4.1 What is involved

Azure Trusted Signing (now branded "Artifact Signing") is Microsoft's managed signing service.
It is the modern replacement for buying OV/EV certificates on hardware tokens: no certificate to
store, no HSM, no renewal ceremony - CI authenticates to Azure and Microsoft signs the binary with
a publicly trusted cert carrying the validated identity.

This is exactly what the workflow's `AZURE_TRUSTED_SIGNING_*` block expects, and `tauri-action`
supports it natively.

### 4.2 Prerequisites and eligibility

- An **Azure subscription** and a Microsoft Entra tenant (Phorma already runs cloud infrastructure,
  so this may exist).
- **Geographic eligibility** (public trust certs): organizations must be in the US, Canada, EU,
  UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, or Israel.
  Individual developers must be in the US or Canada. If the legal entity is elsewhere, the fallback
  is a conventional OV certificate from a CA (SSL.com, Certum, GlobalSign) on a hardware token -
  more operational pain, similar or higher cost.
- **Organization identity validation**: Microsoft verifies the legal entity against public records.
  Have ready: legal business name and address exactly as registered, business registration docs
  issued within the last 12 months, a domain registration/invoice listing the entity, and two email
  addresses on that domain (primary + secondary, distribution lists OK). A representative also
  completes an individual identity check (government ID via AU10TIX).
- **Processing time: 1-20 business days**, occasionally longer if documents are requested.

### 4.3 Provisioning steps

1. Register the `Microsoft.CodeSigning` resource provider on the subscription.
2. Create an **Artifact Signing account** (Basic SKU) in a supported region.
3. Complete **identity validation** (portal only, not CLI) - this is the long pole; start it first.
4. Create a **certificate profile** (Public Trust) bound to the validated identity.
5. Create an Entra app registration with a client secret and grant it the
   `Code Signing Signer` role on the certificate profile (and `Certificate Profile Signer`
   permissions as documented) for CI use.

### 4.4 CI wiring

Uncomment the Windows block in `.github/workflows/release.yml` and set these repository secrets:

| Secret | Value |
|---|---|
| `AZURE_TRUSTED_SIGNING_CLIENT_ID` | Entra app (CI service principal) client ID |
| `AZURE_TRUSTED_SIGNING_CLIENT_SECRET` | that app's client secret |
| `AZURE_TRUSTED_SIGNING_TENANT_ID` | Entra tenant ID |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Artifact Signing account name |
| `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | certificate profile name |

`tauri-action` signs the NSIS installer and the updater executable during bundling. No other
workflow changes.

### 4.5 SmartScreen reputation

Signing removes the "unknown publisher" warning immediately. SmartScreen reputation then builds as
users run the signed installer; Trusted Signing public-trust certificates are recognized by
SmartScreen and gain reputation quickly, unlike self-signed or missing signatures. Expect the
"Windows protected your PC" screen to disappear entirely once signed builds accumulate a modest
install base.

### 4.6 Timeline and cost

| Item | Cost | Elapsed time |
|---|---|---|
| Azure account + resource setup | Free | half a day |
| Artifact Signing Basic tier | **$9.99/month** (5,000 signatures included, then $0.005 each) | - |
| Identity validation | Free | 1-20 business days |
| First signed release | Included | one release cycle |

At the current release cadence (a handful of releases per month, one Windows target), the Basic
tier's 5,000-signature quota is effectively unlimited for this app; overage is negligible.

### 4.7 Detailed walkthrough: Microsoft, step by step (no technical background assumed)

This subsection spells out every click for sections 4.2-4.4 above. The Microsoft path has more
portal screens than Apple's but no Mac and no certificate file handling - Microsoft stores the
certificate on its own servers and signs on the company's behalf. Total active effort is about
half a day, plus a wait of 1-20 business days while Microsoft verifies the company's identity.
Steps 1-7 are administrative; step 8 is a short engineering handoff.

#### What you need before you start

- An Azure account with a subscription the company is willing to bill $9.99/month to. If the
  company already runs cloud infrastructure, this likely exists - ask whoever manages the cloud
  account.
- Permission to create resources in that subscription (the "Contributor" or "Owner" role), or a
  colleague who has it.
- The company's legal name and address exactly as registered.
- A business registration document issued within the last 12 months (for example, a certificate
  of incorporation or a recent registration extract) as a PDF or scan.
- An invoice or registration record for the company's web domain (for example, phorma.com) that
  shows the company's legal name.
- Two email addresses on that domain: a primary contact and a secondary contact. A distribution
  list (for example, admin@phorma.com) works fine for the secondary.
- A government-issued photo ID for the person completing the identity check (a driver's license
  or passport). Microsoft uses a third-party service called AU10TIX to verify it live via webcam
  or document upload.
- A credit card for the $9.99/month subscription cost.

#### Step 1: Check the company is eligible

Microsoft only issues publicly trusted signing certificates to companies registered in the US,
Canada, the EU, the UK, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland,
Norway, or Israel. If the company's legal entity is registered elsewhere, stop here and tell
engineering - the fallback is a conventional certificate from a company like SSL.com or Certum,
which is a different process (see section 4.2).

#### Step 2: Register the signing service in the Azure account

1. Sign in at https://portal.azure.com.
2. Click the search bar at the top, type "Subscriptions", and open it. Click the subscription
   you will use.
3. In the left menu under "Settings", click "Resource providers".
4. In the filter box, type "Microsoft.CodeSigning".
5. Click it in the list, then click the "Register" button at the top, and wait for the status to
   change to "Registered" (usually under a minute).

#### Step 3: Create the signing account

1. In the Azure portal search bar, type "Artifact Signing" (Microsoft recently renamed this
   service from "Trusted Signing"; if you only see "Trusted Signing", use that - same service).
2. Click "Create".
3. Choose the subscription, then "Create new" resource group, and name it something like
   `phorma-signing`.
4. Pick a region from the list (any supported region works; the choice does not affect who can
   verify the installers).
5. Choose the "Basic" pricing tier.
6. Click "Review + create", then "Create", and wait about a minute for deployment.

#### Step 4: Start identity validation (do this FIRST - it is the long wait)

This is where Microsoft confirms the company is a real legal entity. It is done in the portal
only, and it is the step that takes 1-20 business days. Start it before doing anything else in
this walkthrough, then do steps 5-8 while it runs.

1. Open the Artifact Signing account you just created (search for it, click its name).
2. In the left menu, click "Identity validation", then "+ Create".
3. Choose "Individual" if the company is a sole proprietorship; otherwise choose "Organization".
4. Fill in the legal business name and address EXACTLY as they appear on the business
   registration document. Mismatches are the most common cause of delays.
5. Enter the primary and secondary email addresses on the company domain.
6. Upload the business registration document and the domain invoice/registration record.
7. Submit. A representative of the company (you) will also be prompted to complete a personal
   identity check through AU10TIX - have the government ID ready and follow the on-screen
   prompts.
8. Microsoft may email the primary or secondary address with questions. Watch both inboxes,
   including spam folders, and reply the same day - every reply restarts a waiting period.

The status in the portal changes to "Approved" when done. You will also receive an email.

#### Step 5: Create the certificate profile

The certificate profile is the template that says "sign things as the validated company".

1. In the Artifact Signing account, click "Certificate profiles" in the left menu, then
   "+ Create".
2. Name it something like `phorma-public-trust`.
3. Choose "Public Trust" as the profile type and select the identity validation from step 4
   (it must show "Approved").
4. Create it.

#### Step 6: Create the "service principal" (the robot account CI will sign in as)

The release computer needs its own login to use the signing service - Microsoft calls this a
service principal. Think of it as a non-human employee account with exactly one permission.

1. In the Azure portal search bar, type "Microsoft Entra ID" (formerly "Azure Active Directory")
   and open it.
2. In the left menu, click "App registrations", then "+ New registration".
3. Name it something like `phorma-release-signing` and click Register.
4. On the app's Overview page, copy the "Application (client) ID" and the "Directory (tenant)
   ID" - write both down.
5. In the left menu under "Manage", click "Certificates & secrets", then "New client secret".
   Add a description, choose an expiry (24 months is fine), and click Add.
6. Copy the secret "Value" immediately - it is shown only once. Write it down.

#### Step 7: Give the robot account permission to sign

1. Go back to the Artifact Signing account in the portal.
2. Click "Certificate profiles", then click the profile name from step 5.
3. Under "Access control (IAM)" (either on the profile or the account, per the current portal
   layout), click "Add role assignment".
4. Search for and select the role "Code Signing Signer" (the portal may also list
   "Certificate Profile Signer" - assign it too if present).
5. Under "Members", choose "User, group, or service principal", then find and select
   `phorma-release-signing` from step 6.
6. Save.

#### Step 8: Put the five values into GitHub and hand off to engineering

1. Open the phorma-agent-studio repository on github.com while signed in as a repository
   administrator.
2. Click Settings > Secrets and variables > Actions > "New repository secret".
3. Create these five, one at a time:
   - `AZURE_TRUSTED_SIGNING_CLIENT_ID` - the "Application (client) ID" from step 6.4
   - `AZURE_TRUSTED_SIGNING_CLIENT_SECRET` - the secret value from step 6.6
   - `AZURE_TRUSTED_SIGNING_TENANT_ID` - the "Directory (tenant) ID" from step 6.4
   - `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` - the Artifact Signing account name from step 3
   - `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` - the profile name from step 5
     (`phorma-public-trust` in the example)

The final step - uncommenting the Windows block in the release workflow and cutting a test
release - is a short engineering task covered in section 4.4 and step 5 of the execution plan
(section 6).

#### How you will know it worked

After engineering cuts the first signed release, download the installer on a Windows PC and run
it. Instead of the scary blue "Windows protected your PC" full screen, Windows should show the
company's validated name as the publisher. If the warning persists on the very first signed
release, do not panic: Windows SmartScreen builds trust over a short period as more people
install the signed build (section 4.5).

---

## 5. Cost summary

| Item | Type | Amount |
|---|---|---|
| Apple Developer Program (organization) | annual | $99/year |
| Azure Trusted Signing Basic | monthly | $9.99/month (~$120/year) |
| **Core total** | | **~$220/year** |
| Optional: Microsoft Store (Partner Center, org) | one-time | $99 (only if store distribution is ever pursued) |
| Optional: Mac App Store | - | Not viable (sandbox requirement) |
| Optional: conventional OV cert instead of Trusted Signing | annual | ~$100-300/year + hardware token handling; only if Azure eligibility fails |

One-time costs beyond money: roughly 1-2 days of engineering (secrets, uncommenting, one test
release) plus calendar time dominated by identity validation waits.

---

## 6. Ordered execution plan

Detailed click-by-click instructions for the administrative parts of both paths are in
section 3.6 (Apple) and section 4.7 (Microsoft) - written for a reader with no technical
background.

1. **Start the clock on validations first** - both waits are pure calendar time:
   - Request a DUNS number for the legal entity if one does not exist (Apple prerequisite;
     Apple steps 1-2 in section 3.6).
   - Enroll in the Apple Developer Program as an organization (Apple steps 3, section 3.6).
   - Create the Azure Artifact Signing account and submit organization identity validation
     (Microsoft steps 2-4, section 4.7 - start identity validation before anything else).
2. **While waiting**: create the Developer ID certificate and `.p12` once Apple enrollment lands
   (Apple steps 4-7, section 3.6); set up the Entra service principal once Azure validation
   completes (Microsoft steps 6-7, section 4.7).
3. **Add secrets to GitHub** (all ten listed above). Do not touch `release.yml` until every secret
   has a real value - the empty-string gotcha documented in
   `.github/skills/release-playbook/references/failure-modes.md` will otherwise break the build.
4. **Uncomment both env blocks** in `.github/workflows/release.yml` in one PR.
5. **Cut a test release** (a beta version is fine - the pipeline already treats `-` versions as
   prereleases) and verify:
   - Windows: installer shows "Verified publisher: Phorma..." in the UAC/SmartScreen flow; no
     "Windows protected your PC" full-screen block.
   - macOS: `spctl -a -vv /Applications/Phorma\ Agent\ Studio.app` reports
     `accepted; source=Notarized Developer ID`; the DMG opens on a clean Mac without the
     right-click-to-open dance.
   - The in-app updater still works (updater `.sig` files are independent of OS signing, but
     verify the whole chain end to end).
6. **Update the playbook**: once signing is live, remove the "DISABLED until certs are purchased"
   comments and note in `.kiro/steering/release.md` that installers are OS-signed, so future
   releases treat a signing failure as a release blocker.

---

## 7. Verification checklist (post-certification)

- [ ] Fresh Windows VM: download installer from the public site, run it, no SmartScreen warning,
      publisher shows the validated entity name.
- [ ] Fresh macOS machine (both arm64 and x64): open the DMG, drag to Applications, launch with no
      Gatekeeper prompt; `spctl` reports notarized.
- [ ] Auto-update from the previous unsigned version to the new signed version succeeds on both
      platforms (the updater validates minisign signatures, not OS signatures, so this should be
      unaffected - confirm).
- [ ] `gh release view vX.Y.Z --json assets` shows all platform artifacts present (the partial
      matrix gotcha still applies).
- [ ] Azure Artifact Signing usage shows signatures consumed (sanity check that CI actually signed
      rather than silently skipping).

---

## 8. FAQ

**Does the `currentUser` NSIS install mode matter for signing?**
No. Signing is orthogonal to install scope. Per-user install is actually preferable: no UAC
elevation prompt, which pairs well with a clean SmartScreen experience.

**Do we need an EV certificate for instant SmartScreen reputation?**
No. EV certs on hardware tokens are the legacy path. Azure Trusted Signing exists precisely to
replace them, is what the CI already expects, and Microsoft positions its public-trust certs for
SmartScreen recognition.

**Does notarization inspect the app's behaviour?**
Notarization is an automated scan (malware checks, signature correctness, hardened runtime), not a
human review like the App Store. The Rust LLM proxy, keychain access, and database drivers are
irrelevant to it. Turnaround is minutes.

**What breaks if we do nothing?**
Nothing breaks today - unsigned installers still work; users just click through warnings
("More info" -> "Run anyway" on Windows; right-click -> Open on macOS). But every warning is
conversion loss and a phishing-shaped trust hole: an unsigned binary teaches users to ignore the
exact dialog that would warn them about actual malware. Certification is cheap insurance for a
product that asks users to hand it API keys and database credentials.

**Is the Apple $99/year per certificate?**
No - per membership. All certificate types (Developer ID, Mac App Store, iOS) are included.

**Can one person's Apple ID do the notarization?**
Yes, any team member with an app-specific password works. Prefer a shared team account or ensure
the secret owner is not a single point of failure.