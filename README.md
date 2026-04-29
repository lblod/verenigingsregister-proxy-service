# Verenigingsregister Proxy Service

This service acts as a proxy for the Verenigingsregister API, handling authentication, authorization, and header management for requests to the backend API.

## Features

- Forwards requests to the Verenigingsregister API
- Removes sensitive headers before forwarding
- Handles authentication using OAuth2 access tokens with per-client caching
- Multi-tenant support: Each organization has its own OAuth2 client credentials
- Multi-layer authorization:
  - Role-based: checks `verenigingen-beheerder` role
  - Processing agreements: validates organization has processing agreement (configurable)
  - Werkingsgebied: validates the user's admin unit (commune) covers the association's postal code area
- Supports CRUD operations for verenigingen, contactgegevens, locaties, and vertegenwoordigers
- Axios configured to handle 304 (Not Modified) responses gracefully

## Configuration

### Environment Variables

The following environment variables are read from `constants.js`:

#### Authentication & API Configuration

| Variable            | Required | Default                                                          | Description                                                                 |
| ------------------- | -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `SCOPE`             | Yes      | -                                                                | OAuth2 scopes for API access (space-separated)                              |
| `AUD`               | Yes      | -                                                                | OAuth2 audience/authorization server URL                                    |
| `AUTH_DOMAIN`       | No       | `authenticatie.vlaanderen.be`                                    | Authentication domain for token endpoint                                    |
| `API_URL`           | No       | `https://iv.api.vlaanderen.be/api/v1/organisaties/verenigingen/` | Base URL for the Verenigingsregister API                                    |
| `API_VERSION`       | No       | `v1`                                                             | API version sent in `vr-api-version` header                                 |

#### Authorization & Data Access

| Variable                            | Required | Default                                           | Description                                                                      |
| ----------------------------------- | -------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `SESSION_GRAPH`                     | No       | `http://mu.semte.ch/graphs/sessions`              | SPARQL graph URI containing session data                                         |
| `ORGANISATION_GRAPH`                | No       | `http://mu.semte.ch/graphs/public`                | SPARQL graph URI containing organization/OVO code data                           |
| `CLIENT_CONFIG_GRAPH`               | No       | `http://mu.semte.ch/graphs/client-configurations` | SPARQL graph URI containing OAuth2 client configuration per organization         |
| `PROCESSING_AGREEMENT_GRAPH`        | No       | `http://mu.semte.ch/graphs/processing-agreements` | SPARQL graph URI containing processing agreement data                            |
| `ENABLE_PROCESSING_AGREEMENT_CHECK` | No       | `true`                                            | _FEATURE FLAG_ Enable processing agreement validation. Set to `false` to disable |
| `ENABLE_REQUEST_REASON_CHECK`       | No       | `true`                                            | _FEATURE FLAG_ Enable X-Request-Reason header validation. Set to `false` to disable |
| `ENABLE_TERRITORY_CHECK`            | No       | `true`                                            | _FEATURE FLAG_ Enable werkingsgebied (territory) validation. Set to `false` to disable |
| `DATA_ACCESS_LOG_GRAPH`             | No       | `http://mu.semte.ch/graphs/data-access-logs`      | SPARQL graph URI for storing data access logs                                    |
| `ASSOCIATIONS_GRAPH`                | No       | `http://mu.semte.ch/graphs/organizations`         | SPARQL graph URI containing association data (used for werkingsgebied check)     |
| `FALLBACK_HEAD_CLIENT_ID`           | No       | `''`                                              | Fallback OAuth2 client ID for HEAD requests when no per-org client is available  |

**Note:**

- A `.pem` file containing the RSA private key must be mounted in `/config` directory; tokens are fetched via JWT client assertions (RS256)
- The `EDITOR_ROLE` is hardcoded to `verenigingen-beheerder` in constants.js

### Usage Example

```yaml
environment:
  AUD: 'https://authenticatie.vlaanderen.be/op'
  SCOPE: 'dv_magda_organisaties_verenigingen_verenigingen_v1_G dv_magda_organisaties_verenigingen_verenigingen_v1_A dv_magda_organisaties_verenigingen_verenigingen_v1_P dv_magda_organisaties_verenigingen_verenigingen_v1_D'
  SESSION_GRAPH: 'http://mu.semte.ch/graphs/sessions'
  ORGANISATION_GRAPH: 'http://mu.semte.ch/graphs/public'
  CLIENT_CONFIG_GRAPH: 'http://mu.semte.ch/graphs/client-configurations'
volumes:
  - ./config/verenigingen-api-proxy:/config
```

OAuth2 client credentials are resolved per-organization from `CLIENT_CONFIG_GRAPH`.

## Authorization & Processing Agreements

### Authorization Flow

The service implements a multi-layer authorization system:

1. **Role Check**: Validates user role via the `mu-auth-allowed-groups` header:
   - `verenigingen-beheerder`: Full access to all operations
2. **Processing Agreement Validation** (optional): Verifies that the organization has a valid processing agreement
3. **Werkingsgebied Check** (optional): For association-specific requests, validates that the user's admin unit's werkingsgebied covers the association's primary site postal code

### OVO Code Resolution

The service queries the session graph to resolve a session ID to an OVO code:

```sparql
PREFIX session: <http://mu.semte.ch/vocabularies/session/>
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX dct: <http://purl.org/dc/terms/>

SELECT DISTINCT ?identifier WHERE {
  GRAPH <${SESSION_GRAPH}> {
    ?session
      ext:sessionGroup ?adminUnit .
  }

  GRAPH <${ORGANISATION_GRAPH}> {
    ?adminUnit
      dct:identifier ?identifier .
    FILTER(STRSTARTS(STR(?identifier), "OVO"))
  }
}
```

### Processing Agreements Model

**Note:** Processing agreement validation is currently a placeholder implementation.

When `ENABLE_PROCESSING_AGREEMENT_CHECK=true`, the service will validate that the local government (identified by OVO code) has a processing agreement to access the Verenigingsregister API.

**Expected Data Model:**

The processing agreements should be stored in a `PROCESSING_AGREEMENT_GRAPH` with the following structure:

```turtle
PREFIX dpv: <https://w3id.org/dpv#>

<http://example.org/processing-agreement/123>
  dpv:hasDataProcessor <https://data.lblod.info/id/bestuurseenheden/xyz>  # Local government

```

Assumption: the PROCESSING_AGREEMENT_GRAPH contains only currently valid subprocessing agreements.
We only check for existence of agreements, not validity periods.
The agreements in full and their lifecycle are assumed to be managed elsewhere.

### Werkingsgebied Check

For association-specific requests (e.g., `GET /verenigingen/:vCode`), the service validates that the user's administrative unit has jurisdiction over the association's location. This is determined by checking if the association's primary site postal code falls within the admin unit's werkingsgebied (area of operation).

**Error Response:**

```json
HTTP 403
{
  "error": "Forbidden",
  "detail": "Admin unit does not cover association werkingsgebied"
}
```

## Authentication & Token Management

The service uses a multi-tenant authentication approach where each organization (linked to the session) has its own OAuth2 client.

### Client ID Resolution

For each request, the service resolves the client ID from the session using a SPARQL query:

```sparql
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX adms: <http://www.w3.org/ns/adms#>
PREFIX wotsec: <https://www.w3.org/2019/wot/security#>
PREFIX dct: <http://purl.org/dc/terms/>

SELECT DISTINCT ?clientId WHERE {
  GRAPH <${SESSION_GRAPH}> {
    ${sessionId}
      ext:sessionGroup ?adminUnit .
  }

  GRAPH <${CLIENT_CONFIG_GRAPH}> {
    ?adminUnit
      ext:hasSecurityScheme ?oAuthConfig .

    ?oAuthConfig
      a wotsec:OAuth2SecurityScheme ;
      dct:identifier ?clientId .
  }
}
```

**Requirements:**

- Exactly one client ID must be found per session
- The service will reject requests with zero or multiple client IDs

### Token Caching

Access tokens are cached per client ID to improve performance:

- Tokens are cached in memory with their expiration time
- A 60-second safety margin is applied before expiration
- When a cached token is still valid, it's reused without making a new token request
- Each organization's tokens are cached independently

## API Endpoints

### Read Operations (requires `verenigingen-beheerder` role)

- `GET /verenigingen/:vCode` - Retrieve association details. Requires `X-Request-Reason` header when `ENABLE_REQUEST_REASON_CHECK=true` (see [Data Access Logging](#data-access-logging)). Performs werkingsgebied check.
- `HEAD /verenigingen/:vCode` - Check resource existence without logging. Uses fallback client if no per-org client configured (`FALLBACK_HEAD_CLIENT_ID`).
- `GET /verenigingen/:vCode/authorization-check` - Authorization pre-check. Validates role, processing agreement, and werkingsgebied checks without requiring `X-Request-Reason` and without accessing or returning association data. Returns JSON with authorization result and denial details.
- `GET /verenigingen/:vCode/basisinformatie` - Retrieve non-sensitive association data (detail API with sensitive fields stripped). Role check only (no processing agreement, territory, reason checks, or data access logging).

### Write Operations (requires `verenigingen-beheerder` role)

- `POST /verenigingen/:vCode/contactgegevens`
- `PATCH /verenigingen/:vCode/contactgegevens/:id`
- `DELETE /verenigingen/:vCode/contactgegevens/:id`
- `POST /verenigingen/:vCode/locaties`
- `PATCH /verenigingen/:vCode/locaties/:id`
- `DELETE /verenigingen/:vCode/locaties/:id`
- `POST /verenigingen/:vCode/vertegenwoordigers`
- `PATCH /verenigingen/:vCode/vertegenwoordigers/:id`
- `DELETE /verenigingen/:vCode/vertegenwoordigers/:id`

### Authorization Responses

All endpoints return detailed authorization failure messages:

**Success:**

```json
HTTP 200/201/204
```

**Unauthorized - Missing Role:**

```json
HTTP 401
{
  "error": "Unauthorized",
  "detail": "Missing required role: verenigingen-beheerder"
}
```

**Unauthorized - No OVO Code:**

```json
HTTP 401
{
  "error": "Unauthorized",
  "detail": "Processing agreement check failed: No OVO code found for session"
}
```

**Forbidden - Werkingsgebied Check Failed:**

```json
HTTP 403
{
  "error": "Forbidden",
  "detail": "Admin unit does not cover association werkingsgebied"
}
```

**Authorization Pre-check - Authorized:**

```json
HTTP 200
{
  "authorized": true,
  "detail": "Request authorized"
}
```

**Authorization Pre-check - Denied:**

```json
HTTP 403
{
  "authorized": false,
  "detail": "Admin unit does not cover association werkingsgebied"
}
```

## Data Access Logging

The service logs all `GET /verenigingen/:vCode` requests to the triple store for audit purposes. This ensures traceability of who accessed sensitive vereniging data, when, and for what reason.

### X-Request-Reason Header

When `ENABLE_REQUEST_REASON_CHECK=true` (default), the `GET /verenigingen/:vCode` endpoint requires a mandatory `X-Request-Reason` header containing a valid reason code UUID. This header is validated against the triple store before the request is processed.

Set `ENABLE_REQUEST_REASON_CHECK=false` to disable this validation (e.g., for development or testing).

**Request Example:**

```http
GET /verenigingen/V0123456
X-Request-Reason: cd64bd95-2a41-4a76-a927-20df200be10b
```

**Error Responses:**

Missing header:
```json
HTTP 400
{
  "error": "Bad Request",
  "detail": "Missing required header: X-Request-Reason"
}
```

Invalid reason code:
```json
HTTP 400
{
  "error": "Bad Request",
  "detail": "Invalid X-Request-Reason value"
}
```

### Reason Codes Data Model

Reason codes must be stored in the triple store with the following structure, similar to [lblod/privacy-centric-service](https://github.com/lblod/privacy-centric-service)

```turtle
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

<http://data.lblod.info/reason-codes/cd64bd95-2a41-4a76-a927-20df200be10b> a ext:ReasonCode ;
  mu:uuid "cd64bd95-2a41-4a76-a927-20df200be10b" ;
  skos:prefLabel "Reason label" .
```

### Log Entry Data Model

Each data access is logged as an `ext:SensitiveInformationRead` resource, , similar to [lblod/privacy-centric-service](https://github.com/lblod/privacy-centric-service):

```turtle
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

<http://data.lblod.info/id/data-access-logs/{uuid}> a ext:SensitiveInformationRead ;
  mu:uuid "{uuid}" ;                     # Internal identifier
  ext:date "{timestamp}"^^xsd:dateTime ; # Required
  ext:success "{boolean}"^^xsd:boolean ; # Required
  ext:resource <{resourceLocation}> ;    # Optional - may be missing if request failed early
  ext:reason <{reasonUri}> ;             # Optional - may be missing if validation failed
  ext:person <{personUri}> ;             # Optional - may be missing if no session
  ext:adminUnit <{adminUnitUri}> ;       # Optional - may be missing if no session
  ext:etag "{etag}" ;                    # Optional - only for successful requests
  ext:errorMessage "{message}" .         # Optional - only for failed requests
```

**Required fields:** `mu:uuid`, `ext:date`, `ext:success`

**Optional fields:** All other fields are only included when they have values. This ensures logging doesn't fail when session info or reason validation is incomplete.

### Retrieving Access Logs

Query all data access logs:

```sparql
PREFIX ext: <http://mu.semte.ch/vocabularies/ext/>
PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT ?log ?uuid ?date ?resource ?reason ?reasonLabel ?person ?adminUnit ?adminUnitLabel ?success ?etag ?errorMessage
WHERE {
  GRAPH <http://mu.semte.ch/graphs/data-access-logs> {
    ?log a ext:SensitiveInformationRead ;
      mu:uuid ?uuid ;
      ext:date ?date ;
      ext:success ?success .

    OPTIONAL { ?log ext:resource ?resource }
    OPTIONAL {
      ?log ext:reason ?reason
      OPTIONAL {
        GRAPH ?reasonGraph {
          ?reason skos:prefLabel ?reasonLabel .
        }
      }
    }
    OPTIONAL { ?log ext:person ?person }
    OPTIONAL {
      ?log ext:adminUnit ?adminUnit
      OPTIONAL {
        GRAPH <http://mu.semte.ch/graphs/public> {
          ?adminUnit skos:prefLabel ?adminUnitLabel .
        }
      }
    }
    OPTIONAL { ?log ext:etag ?etag }
    OPTIONAL { ?log ext:errorMessage ?errorMessage }
  }
}
ORDER BY DESC(?date)
```


## Development

- Code is organized in the `lib/` directory
- Main entry point: `app.js`
- Router logic: `lib/verenigingenRouter.js`
- Authorization: `lib/authorizationCheck.js`
- Authentication: `lib/authenticator.js`
- Configuration: `constants.js`

## License

MIT
