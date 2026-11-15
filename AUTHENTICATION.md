# Authentication and authorization

The API uses signed JWT bearer tokens. Log in with `POST /login`, then send the
returned token on protected routes using this header:

```http
Authorization: Bearer <token>
```

Missing tokens return `401`; invalid or expired tokens return `403`. Each
authenticated request also checks the user's active status in MySQL.

Public registrations can create `user` accounts. Creating an `admin` or
`manager` account requires an existing admin token. Newly registered accounts
are active.

See [README.md](./README.md) for database configuration, setup instructions,
the complete API reference, endpoint permissions, and examples.
