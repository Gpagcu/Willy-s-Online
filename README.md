# Willy's Leather Craft & Military Clothing: Online Store + POS

Home page, product search and categories, cart, checkout (Cash on delivery, Pay in store, GCash, Maya, Bank transfer), order history, profile, customer chat, sign-up with email verification (Neon Auth), and an admin area: dashboard, product/inventory editor, orders, in-store POS with printable receipt, chat inbox. Works on phones (burger menu).

Stack: Node.js + Express, Neon Postgres, Neon Auth, plain HTML/CSS/JS.

---

## A. Set up a brand-new Neon project (do this first)

1. Go to https://neon.com, sign in, and click **New project**. Pick a name (for example `willys-store`) and the region closest to you (Singapore for the Philippines), then **Create**.
2. **Database connection string:** on the project dashboard click **Connect** and copy the connection string (starts with `postgresql://`, ends with `?sslmode=require`). Keep it private. This is your `DATABASE_URL`.
3. **Turn on Auth:** open **Auth** in the left menu and enable it ("Managed Better Auth"). Then:
   - **Configuration tab:** copy the **Auth URL** (like `https://ep-xxxx.neon.tech/neondb/auth`). This is your `NEON_AUTH_URL`.
   - **Settings > Better Auth** (or the Auth settings page), make sure these are ON:
     - Sign-up with Email
     - Verify at Sign-up, with method **Verification code** (the "link" option is not available on Neon's shared sender)
     - Sign-in with Email
     - Allow Localhost (needed while testing on your computer)
4. **Set up your own email sender (strongly recommended).** Neon's built-in sender is for testing and sends very few emails, so codes may stop arriving. On the same settings page scroll down past "OAuth providers" to the email provider section, choose **Custom SMTP provider**, and enter:
   - Host `smtp.gmail.com`, Port `587`
   - Username and Sender email: your Gmail address
   - Password: a Gmail **App Password** (turn on 2-Step Verification, then create one at https://myaccount.google.com/apppasswords)
   - Sender name: Willy's Leather Craft
   - Click **Save**.

## B. Run the site on your computer

1. Install Node.js 18 or newer from https://nodejs.org
2. In this folder run: `npm install` (it also builds `public/neon-auth.js`; if that file is missing, run `npm run build`)
3. Copy `.env.example` to `.env` (Windows: `copy .env.example .env`) and fill in:
   - `DATABASE_URL` from step A2
   - `NEON_AUTH_URL` from step A3
   - `ADMIN_EMAIL`: a real email you can open
   - `GCASH_NUMBER`, `GCASH_NAME`, `BANK_DETAILS`
4. Run `npm start` and open http://localhost:3000

On first start the app creates all the tables and 10 sample products. Edit or hide them in Admin > Products.

## C. Become the admin

1. Click **Sign up** (not Log in) with the exact `ADMIN_EMAIL`, choose a password you will remember, and enter the 6-digit code from your email.
2. You land on the Admin dashboard. Next time use **Log in**.

There is no admin password in any file. The admin is simply the account that verified the `ADMIN_EMAIL` address. Any other email is a normal customer.

**If emails will not arrive yet (testing only):** in Neon switch **Verify at Sign-up** off, add `REQUIRE_VERIFIED_EMAIL=false` to `.env`, and restart. Sign up and log in with no code, then in Neon's **SQL Editor** run:

```sql
INSERT INTO users (name, email, role)
VALUES ('Willy', 'your-admin-email@gmail.com', 'admin')
ON CONFLICT (email) DO UPDATE SET role = 'admin';
```

(Use `INSERT`, not `UPDATE`: the users table has no rows until the first login, and `UPDATE` changes nothing on an empty table.) Log out and in again. Before publishing, turn verification back on and remove that `.env` line.

To make another admin later, after they have logged in once:
`UPDATE users SET role='admin' WHERE email='someone@example.com';`

## D. Using it

- **Customers:** sign up, browse/search, add to cart, check out. For GCash/Maya/Bank transfer they send the payment and type the reference number.
- **Admin > Orders:** mark payment "paid", move orders to confirmed/shipped/completed. Cancelling puts the stock back.
- **Admin > POS:** walk-in sales with change calculation and a printable receipt. Stock goes down automatically.
- **Admin > Chat:** reply to customers.

## E. Publish (Render)

1. Put the project on GitHub (`.gitignore` keeps `.env` and `node_modules` out; never upload `.env`).
2. On https://render.com choose New > Web Service and connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Environment variables: `DATABASE_URL`, `NEON_AUTH_URL`, `ADMIN_EMAIL`, `GCASH_NUMBER`, `GCASH_NAME`, `BANK_DETAILS`, `NODE_ENV=production`.
5. In Neon **Settings > Better Auth > Domains** add your Render address (and your own domain later). Turn **Allow Localhost** off for production.

## Photos

- **Chat:** the camera button next to the message box lets customers and the admin send a picture (shrunk to 1280px automatically).
- **Products:** in Admin > Products use **Upload a photo**, or paste a direct image link.
- **Supported photo links:** a direct, public `https://` link to the picture file itself (ends in .jpg, .jpeg, .png, .webp or .gif, and opens as just the picture in a new tab). These do NOT work: page links (Facebook posts, Pinterest pins, `imgur.com/abc` pages, Google Drive share links), links that need a login, and `http://` links. Easiest: just use **Upload a photo**.
- Photos are stored in your Neon database (table `images`), so they survive re-deploys. They count toward your Neon storage.
- Photo links are long random addresses that cannot be guessed, but anyone who has a link can open it.

## Troubleshooting

| What you see | What it means |
|---|---|
| Red box: "could not load your account (no-token)" | The browser has no login token. You are probably not logged in (wrong password gives a 401 in the F12 console) or the files in `public/js/` are old copies. Hard-refresh with Ctrl+Shift+R. |
| "... (ERR_JWT_CLAIM_VALIDATION_FAILED)" or "Auth token rejected" in the terminal | Token issuer mismatch: check `NEON_AUTH_URL` is exactly the Auth URL from the console. |
| Verification code never arrives | Neon's shared sender is limited. Set up the Custom SMTP provider (step A4). Check spam too. |
| Code rejected / "Invalid OTP" | Use only the newest code; each resend invalidates older ones. |
| Sign-in is 401 in the F12 console | Wrong email or password. Delete the user in Neon (Auth > Users) and sign up again. |
| Logged in but no Admin menu | The email does not match `ADMIN_EMAIL` exactly, or the email is not verified. Use the SQL in section C. |
| "Database setup failed" when starting | `DATABASE_URL` is wrong or Neon is unreachable on your network. |
| "Sign-in is not available" on the page | `public/neon-auth.js` is missing (run `npm install` / `npm run build`) or `NEON_AUTH_URL` is not set. |

## Notes

- GCash, Maya and bank payments are verified by you against the reference number. Automatic payments need a gateway such as PayMongo.
- Neon's `@neondatabase/auth` package is currently in beta.
- Forgot password (emailed code) and Change password (in My profile) are built in. They use the same email sender as sign-up codes.
- If you collect customer data in the Philippines, show a short privacy notice (Data Privacy Act). Check with a lawyer.

## Files

```
server.js            API routes, Neon token check, order/stock logic
db.js                database connection, auto-setup, sample products
schema.sql           table definitions
auth-client-src.js   source for the Neon Auth browser bundle
public/              the website (index.html, styles.css, logo.png, neon-auth.js)
public/js/           the site's code, one file per topic (see below)
.env.example         settings template
```

### Where to edit (public/js/, loaded in this order)

| File | What is inside |
|---|---|
| `core.js` | shared helpers, app state, toast messages, cart helpers |
| `api.js` | login token, talking to the server, photo upload |
| `nav.js` | top menu, unread chat badge |
| `shop.js` | home page, shop and search, cart, checkout |
| `auth.js` | sign up, log in, verify email, forgot password |
| `account.js` | My profile, My orders (payment proof button) |
| `chat.js` | customer chat and the admin chat inbox |
| `admin.js` | admin menu, dashboard, products and inventory, orders |
| `admin-reports.js` | admin sales reports |
| `admin-pos.js` | admin in-store POS and receipt |
| `main.js` | page router, menu button, start-up (keep last) |

New code files must be added to `public/index.html` as a `<script>` line before `main.js`.