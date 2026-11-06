# Supertax Practice Desk

Supertax's internal web portal for client work: BAS, IAS, payroll, individual, company, trust and SMSF returns, FBT, TPAR, ASIC reviews and more. Each job has a due date, the person doing it, a reviewer, notes and a status. Everyone signs in with their own email and password, and the master admin controls who has access.

- **Website:** Next.js 15 (React 19), hosted on Vercel
- **Database and sign-in:** Supabase (Postgres + Auth), protected by row level security
- **Branding:** the Supertax logo and colours from the Supertax website

## What it does

- **Overview:** overdue jobs, jobs due in the next 7 days, jobs waiting on clients, jobs ready for review or lodgment, lodgments this month, open work by service, and each person's workload.
- **Jobs:** filter by service, status, due date, person or client. Change a job's status straight from the list, or export it to CSV.
- **Create jobs for a period:** for example, create every quarterly BAS for Q2 FY27 at once. Clients that already have that job are skipped. Due dates are suggested from the ATO tax agent lodgment program and can be changed.
- **Clients:** entity type, ABN, contact details, manager, services, BAS cycle and notes, plus each client's open and lodged jobs.
- **Team and access:**
  - **Master admin:** adds people, sets roles, resets passwords and switches access off.
  - **Manager:** can delete clients and jobs.
  - **Staff:** can add and update clients and jobs.
- **Live updates:** a change one person makes shows on everyone else's screen.

## Who can do what (enforced in the database)

| | Staff | Manager | Master admin |
|---|---|---|---|
| See and update clients and jobs | ✓ | ✓ | ✓ |
| Delete clients and jobs | | ✓ | ✓ |
| Add people, change roles, reset passwords, switch access off | | | ✓ |

Someone whose access is switched off can't sign in, and the database refuses their requests even if they still have an old session. Nobody can sign up on their own: only the master admin can create accounts.

---

## Go-live guide (about 30 minutes, no coding)

You need three free accounts: **GitHub** (you already have one), **Supabase** and **Vercel**.

### 1. Create the database (Supabase)

1. Go to <https://supabase.com>, sign up, and click **New project**.
2. Name it `supertax-practice`. Choose a strong database password and save it in your password manager. Pick the **Sydney** region, then click **Create**.
3. When the project is ready, open **SQL Editor** → **New query**. Paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. You should see "Success".
4. Go to **Authentication** → **Sign In / Providers**. Turn **off** "Allow new users to sign up" and save.
5. Go to **Project Settings** → **API**. Keep this tab open, because you'll copy three values from it:
   - **Project URL**
   - **anon public** key
   - **service_role** key. This one is secret: never share it or paste it anywhere except Vercel.

### 2. Put the website online (Vercel)

1. Go to <https://vercel.com> and sign up with your GitHub account.
2. Click **Add New** → **Project**, then import the `supertax-practice` repository.
3. Before deploying, open **Environment Variables** and add these three:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | the Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |

4. Click **Deploy**. After about two minutes you'll get an address like `https://supertax-practice.vercel.app`.

### 3. Create your master admin account

1. Open the new address. The first visit goes to **Create the master admin**.
2. Enter your name, email and a password of at least 10 characters. This screen works only once: after that, the only way in is the sign-in page.

### 4. Add your team

1. Go to **Team** → **Add team member**. Enter their name, email and role.
2. You'll get a temporary password. Send it to them privately, for example by text.
3. The first time they sign in, they choose their own password.

If someone forgets their password, go to **Team** → **Manage** → **Reset password**. When someone leaves, choose **Switch off access**.

### 5. Use your own address (optional): portal.supertax.com.au

1. In Vercel, open the project → **Settings** → **Domains**. Add `portal.supertax.com.au`.
2. Wherever supertax.com.au's DNS is managed, add the record Vercel shows. It's usually a **CNAME** record named `portal` pointing to `cname.vercel-dns.com`.
3. Wait for Vercel to show a green tick, which can take up to an hour.
4. In Supabase, go to **Authentication** → **URL Configuration** and set **Site URL** to `https://portal.supertax.com.au`.

### Costs

Supabase and Vercel both have free plans, which are enough for a small practice. Paid plans begin at about US$25/month (Supabase Pro) and US$20/month (Vercel Pro). The Supabase free plan pauses a project after a week with no activity; daily use keeps it awake. Upgrade to Pro if you want daily backups.

---

## For developers

```bash
cp .env.example .env.local   # fill in the three values
npm install
npm run dev                  # http://localhost:3000
npm run typecheck
```

- `supabase/schema.sql` creates the tables, access rules and live-update settings. You can run it more than once safely.
- `app/api/admin/*` and `app/api/setup` are the only code that uses the service role key. Each one checks first that the caller is allowed.
- Suggested due dates are in `lib/domain.ts` (`suggestDue`). Check them against the ATO lodgment program every year.
