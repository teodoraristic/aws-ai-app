# Seed script

Populates the deployed Cognito user pool **and** the DynamoDB table with
fake users (and optionally slots + sample bookings) so you can poke the
app without clicking through the sign-up flow N times.

## Setup (once)

```bash
cd aws-app/backend/scripts
npm install
```

The script uses your default AWS credential chain (the same profile your
`cdk deploy` and `aws` CLI use). Region defaults to `eu-west-1`; override
with `AWS_REGION=...` if needed.

## Run

| Command | What it does |
|---|---|
| `npm run seed` | Idempotent. Creates the fixture users in Cognito (skips ones that already exist) and writes their `USER#<sub>/PROFILE` rows in DynamoDB. |
| `npm run seed:reset` | Deletes previously seeded users + rows, then re-seeds from scratch. |
| `npm run seed:with-data` | Seeds users **plus** 28 days of slots per professor (past + future), classes, and a varied set of bookings (booked + cancelled, solo + group) so the Analytics dashboard has data for every chart. |
| `npm run seed:fresh` | `--reset` + `--with-data`. The most useful one for an end-to-end demo. |
| `npm run backfill:cancelled-by` | Dry-run: list cancelled consultations missing a `cancelledBy` attribution (legacy rows from before that field existed). |
| `npm run backfill:cancelled-by:apply` | Stamp those rows with `cancelledBy="unknown"` and a best-guess `cancelledAt` so the data shape is uniform across history. The UI shows a generic "Cancelled" label for `unknown`. |

## Login credentials

All seeded users share the same password — `Test1234!` by default
(override with `SEED_PASSWORD=...`). Emails:

| Role | Email |
|---|---|
| Professor | `ana.petrovic@example.edu` |
| Professor | `marko.jovanovic@example.edu` |
| Professor | `ivana.nikolic@example.edu` |
| Student | `luka.simic@example.edu` |
| Student | `milica.djordjevic@example.edu` |
| Student | `stefan.popovic@example.edu` |
| Student | `jovana.markovic@example.edu` |
| Student | `filip.ilic@example.edu` |
| Admin | `admin@example.edu` |

> The admin user only sees the **Analytics** page. It's the only role
> authorised to call `GET /analytics/admin`.

## Safety

Every row written by this script carries a `seedTag = "seed-fixture-v1"`
attribute. The reset path **only deletes rows with that tag**, so a real
user that registered through the UI can never be wiped out by accident.

## Why not let the post-confirmation Lambda do the DynamoDB row?

`AdminCreateUser` in Cognito does not fire the
`PostConfirmation_ConfirmSignUp` trigger (which is the only one our
Lambda listens for). So the script writes the profile row itself, in the
same shape that `auth-post-confirmation/handler.js` would have written
during a real signup.
