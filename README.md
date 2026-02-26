# Beacon Backend API

## Profile Endpoints

### `GET /me`
- Auth: `Authorization: Bearer <firebase_id_token>`
- Returns current user profile and includes `profile_image_url`.

### `GET /users`
- Auth: `Authorization: Bearer <firebase_id_token>`
- Compatibility alias for current user profile.
- Returns same shape as `GET /me`, including `profile_image_url`.

### `PATCH /me`
- Auth: `Authorization: Bearer <firebase_id_token>`
- Partially updates current authenticated user (`firebase_uid` from token).

Request body (all optional, validated if present):
- `full_name`: string, 2-50 characters
- `email`: valid email
- `phone_number`: string, `+` and digits, 10-20 characters
- `profile_image_url`: valid `http/https` URL

Response (`UserDto`):
- `id`
- `firebase_uid`
- `email`
- `full_name`
- `phone_number`
- `role`
- `profile_image_url`

## Curl Examples

Update one field:

```bash
curl -X PATCH http://localhost:3000/me \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Jane Doe"
  }'
```

Update all editable fields:

```bash
curl -X PATCH http://localhost:3000/me \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "full_name": "Jane Doe",
    "email": "jane.doe@example.com",
    "phone_number": "+15551234567",
    "profile_image_url": "https://cdn.example.com/profiles/jane.jpg"
  }'
```

Clear profile image:

```bash
curl -X PATCH http://localhost:3000/me \
  -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "profile_image_url": null
  }'
```
