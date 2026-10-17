# ClickSurvey

ClickSurvey is a lightweight event-triggered survey platform built with Node.js, Express, MySQL, and EJS. External apps can send events to ClickSurvey, which creates private survey invites and emails the right survey at the right moment.

## Features

- Admin login and session-based auth
- Survey builder with multiple question types
- Public survey links and private invite links
- Event API for external apps: `/api/events`
- Automation rules to map events to surveys
- API client management with hashed API keys
- Suppression list for email opt-out
- Response dashboards and CSV export
- SMTP email invites using Nodemailer

## Install

1. Copy `.env.example` to `.env`
2. Install dependencies:

```bash
npm install
```

3. Configure `.env` with your database and SMTP settings.

## Database Setup

Create a MySQL database and user, then run the schema:

```bash
mysql -u root -p clicksurvey < schema.sql
```

## Seed Data

Insert an admin user and sample records manually using the SQL below. Replace the password hash with one generated using bcrypt.

```sql
INSERT INTO users (name, email, password_hash, created_at, updated_at)
VALUES ('Admin', 'admin@clicksurvey.com.au', '$2b$10$H5q5uvJRxZLHuOoIT2RNkOW9eyItOXTN2eSivFyck.I/EnFWE4j6.', NOW(), NOW());

INSERT INTO api_clients (client_name, api_key_hash, status, created_at, updated_at)
VALUES ('VitaePro', '$2b$10$/Y7l/1s5E4a3KWrC70nDXuYKXSga813cyAFzFbU2UDNKahDpW.pam', 'Active', NOW(), NOW()),
       ('Puzzle Path', '$2b$10$oplYv6N2dfP2zXeTAUoXXe2u1F/LbP1TR4N4KcX5sOe0D3a1z4iMq', 'Active', NOW(), NOW());
```

## Run Locally

```bash
npm start
```

Open `http://localhost:3000`

## Deployment

For cPanel/VentraIP style hosting:

- Upload the project files to your hosting directory
- Ensure Node.js support is enabled
- Install dependencies with `npm install`
- Set environment variables in your hosting control panel
- Run `npm start` or use a process manager like PM2
- Point your domain to the app's URL

## API Client

Create an API client in the admin area. Copy the raw API key once.

## Event API

POST `/api/events`

Headers:

- `Content-Type: application/json`
- `Authorization: Bearer API_KEY_HERE`

Payload:

```json
{
  "sourceApp": "VitaePro",
  "eventType": "cover_letter_created",
  "recipient": {
    "name": "Andrew Baillie",
    "email": "andrew@example.com"
  },
  "metadata": {
    "userId": 123,
    "coverLetterId": 456,
    "plan": "free"
  }
}
```

## Example VitaePro Integration (Node.js)

```js
await fetch('https://clicksurvey.com.au/api/events', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.CLICKSURVEY_API_KEY}`
  },
  body: JSON.stringify({
    sourceApp: 'VitaePro',
    eventType: 'cover_letter_created',
    recipient: {
      name: user.name,
      email: user.email
    },
    metadata: {
      userId: user.id,
      coverLetterId: coverLetter.id
    }
  })
});
```

## Example Puzzle Path WordPress Integration (PHP)

```php
wp_remote_post('https://clicksurvey.com.au/api/events', [
    'headers' => [
        'Content-Type'  => 'application/json',
        'Authorization' => 'Bearer ' . CLICKSURVEY_API_KEY,
    ],
    'body' => json_encode([
        'sourceApp' => 'Puzzle Path',
        'eventType' => 'hunt_completed',
        'recipient' => [
            'name'  => $customer_name,
            'email' => $customer_email,
        ],
        'metadata' => [
            'bookingId' => $booking_id,
            'huntName'  => $hunt_name,
            'huntCode'  => $hunt_code,
        ]
    ])
]);
```

## Notes

- The API uses hashed API keys and rejects disabled clients.
- Automation rules are available now and support delay settings for future enhancement.
- Suppressed emails are blocked automatically.
- Public and private survey pages are designed for simple responsive use.
