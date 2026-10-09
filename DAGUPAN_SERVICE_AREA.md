# Dagupan service area

The backend, Android app (`../Beacon`), and admin app (`../beacon-admin`) use
public `GET /service-area`. It returns the stored GeoJSON FeatureCollection from
`src/data/dagupan-city.geojson`, including its bbox and attribution. No database,
authentication, or external geocoding is needed to retrieve or validate it.

## Boundary source

The snapshot is Dagupan City, Pangasinan from the
[DPWH City/Municipal Boundaries layer](https://services1.arcgis.com/IwZZTMxZCmAmFYvF/ArcGIS/rest/services/City_Municipal_Boundaries/FeatureServer/0),
queried with `MUNICIPAL='Dagupan City'`, `outSR=4326`, and `f=geojson`.
Original source NAMRIA; digitally rectified by GIA Staff, Statistics Division,
Planning Service, DPWH (March 2022). References: OpenStreetMap and Philippine
Statistics Authority. The source date is March 2022, not the retrieval date.

The returned geometry is preserved, including every ring and coordinate. This
particular source feature is a Polygon with one ring. Validation also supports
Polygon holes and MultiPolygon islands; it accepts all polygon boundary edges
and vertices and excludes hole interiors. GeoJSON coordinates are longitude,
latitude. Camera bounds use the surrounding rectangle; submission eligibility
uses the polygon. Nearby basemap tiles can remain visible.

## API contract

New `POST /me/bootstrap`, `POST /sos`, and `POST /incidents` requests require
numeric `latitude` and `longitude`. Profile creation happens only through
bootstrap after location validation. Existing profiles can still log in and
repeat bootstrap outside Dagupan or without coordinates.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `LOCATION_REQUIRED` | Both coordinates are absent. |
| 400 | `INVALID_LOCATION` | Partial, nonnumeric, nonfinite, or out-of-range coordinates. |
| 422 | `OUTSIDE_SERVICE_AREA` | Beacon is currently available only within Dagupan City. |
| 403 | `PROFILE_SETUP_REQUIRED` | Firebase identity has no Beacon profile; complete profile setup. |

Rejected creations produce no Beacon profile, SOS case, incident, notification,
or push. Authentication may refresh an existing profile. Existing active SOS
tracking and acknowledgement/closure controls continue outside Dagupan. Outside
markers are excluded from maps; their records remain in operational lists and
details. Coordinates received by the API are client supplied; the polygon
check does not attest the physical location of a modified client.

## Verification and coordinated release

Run backend `npm.cmd test`, admin `npm.cmd test -- --run` and `npm.cmd run build`,
and Android `gradlew.bat :app:testDebugUnitTest :app:assembleDebug`.
Backend HTTP tests stub Firebase verification and MongoDB model calls; staging
must verify the real services and storage effects.

Before release, validate the three coordinated changes in staging:

- Try new signup, SOS, and incidents inside, on the boundary, outside, and in a
  bbox corner outside the polygon. Direct API requests must enforce the same rule.
- Confirm rejected requests leave MongoDB, Firestore SOS sessions, notifications,
  and push untouched. Confirm Firebase-only users return to setup after login,
  app restart, and backend rejection; retry setup successfully from inside Dagupan.
- On an Android device test precise permission denial, approximate-only location,
  disabled location services, an unavailable/failing location fix, and retries.
  Each submission requests a fresh fix; no default or cached coordinate may pass.
- Drag, zoom, rotate, resize, recenter, open notification links, and change map
  styles. Verify boundary rendering, camera limits, and marker exclusion without
  hiding records or losing real tracking coordinates outside the city.
- Start an SOS inside, move outside, and confirm it stays active and can still
  be acknowledged and closed. Existing users must still log in outside Dagupan.

Release the matching Android/admin versions with the backend. Older Android
versions must update to register or submit reports requiring location. Device
checks and staging validation are release gates; a local build alone is not
deployment evidence.

## Local verification (2026-10-07)

| Check | Result |
| --- | --- |
| Backend full suite | 116 passed. Latest expanded service-area HTTP/geometry checks: 7 passed. |
| Admin affected suite | 41 passed across 7 files, including map and geometry checks. |
| Admin production build | Passed. |
| Admin full suite | 222 passed, 11 failed across 3 unchanged test files. |
| Android unit tests | 24 passed, including boundary/freshness and accepted/rejected SOS publication order. |
| Android debug APK | `:app:assembleDebug` passed; `../Beacon/app/build/outputs/apk/debug/app-debug.apk`. |

The admin full-suite failures are existing expectations in
`src/api/useNotifications.test.jsx` (4), `src/pages/LiveSOS.test.jsx` (3), and
`src/components/layout/Header.test.jsx` (4): numeric versus string IDs, invalid-ID
navigation, and an ambiguous text selector. Their source/test files match HEAD;
the LiveSOS tests mock the dialog containing MapCanvas. The new map code is
excluded from those failure paths. Existing ID compatibility was preserved.

The downloaded geometry was compared with the stored geometry without changing
any coordinates. All 136 source vertices and 135 edge midpoints are accepted;
the southwest bbox corner is excluded. Direct HTTP rejection tests assert zero
profile creations, report/case writes, notification writes, or messaging calls.

No Android device/emulator was connected. Native permission/GPS/recovery/map
checks, real browser/WebGL interaction checks, and staging verification remain
pending. Nothing was deployed.
