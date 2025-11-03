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
| `ENVIRONMENT`       | No       | `DEV`                                                            | Environment mode: `DEV` (uses Basic Auth) or `PROD` (uses JWT with RSA key) |
| `AUTHORIZATION_KEY` | DEV only | `''`                                                             | Base64-encoded Basic Auth credentials for DEV mode                          |
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

**Note:**

- In `PROD` mode, a `.pem` file containing the RSA private key must be mounted in `/config` directory
- The `EDITOR_ROLE` is hardcoded to `verenigingen-beheerder` in constants.js

### Usage Examples

#### Development (T&I API)

```yaml
environment:
  ENVIRONMENT: "DEV"
  AUD: "https://authenticatie-ti.vlaanderen.be/op"
  API_URL: "https://iv.api.tni-vlaanderen.be/api/v1/organisaties/verenigingen/"
  AUTHORIZATION_KEY: "your-base64-key"
  AUTH_DOMAIN: "authenticatie-ti.vlaanderen.be"
  SCOPE: "dv_magda_organisaties_verenigingen_verenigingen_v1_G dv_magda_organisaties_verenigingen_verenigingen_v1_A dv_magda_organisaties_verenigingen_verenigingen_v1_P dv_magda_organisaties_verenigingen_verenigingen_v1_D"
  SESSION_GRAPH: "http://mu.semte.ch/graphs/sessions"
  ORGANISATION_GRAPH: "http://mu.semte.ch/graphs/public"
  CLIENT_CONFIG_GRAPH: "http://mu.semte.ch/graphs/client-configurations"
  ENABLE_PROCESSING_AGREEMENT_CHECK: "false"
```

**Note:** In DEV mode, OAuth2 client credentials are resolved per-organization from `CLIENT_CONFIG_GRAPH`.

#### Production

```yaml
environment:
  ENVIRONMENT: "PROD"
  AUD: "https://authenticatie.vlaanderen.be/op"
  SCOPE: "dv_magda_organisaties_verenigingen_verenigingen_v1_G dv_magda_organisaties_verenigingen_verenigingen_v1_A dv_magda_organisaties_verenigingen_verenigingen_v1_P dv_magda_organisaties_verenigingen_verenigingen_v1_D"
  SESSION_GRAPH: "http://mu.semte.ch/graphs/sessions"
  ORGANISATION_GRAPH: "http://mu.semte.ch/graphs/public"
  CLIENT_CONFIG_GRAPH: "http://mu.semte.ch/graphs/client-configurations"
volumes:
  - ./config/verenigingen-api-proxy:/config
```

**Note:** In PROD mode, each organization must have:
- A `.pem` file with their RSA private key mounted in `/config` directory
- OAuth2 client configuration stored in `CLIENT_CONFIG_GRAPH`

## Authorization & Processing Agreements

### Authorization Flow

The service implements a multi-layer authorization system:

1. **Role Check**: Validates that the user has the `verenigingen-beheerder` role via the `mu-auth-allowed-groups` header
2. **Session to OVO Code Mapping**: Extracts the OVO code (organization identifier) from the user's session using a SPARQL query
3. **Processing Agreement Validation** (optional): Verifies that the organization has a valid processing agreement

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

**Requirements:**

- Exactly one OVO code must be found per session
- The service will reject requests with zero or multiple OVO codes

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

## Authentication & Token Management

The service uses a multi-tenant authentication approach where each organization (linked to the session) has its own OAuth2 client credentials.

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

- `GET /verenigingen/:vCode` (kept a safe/idempotent endpoint for dev and testing. Might be removed later.)
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

## Development

- Code is organized in the `lib/` directory
- Main entry point: `app.js`
- Router logic: `lib/verenigingenRouter.js`
- Authorization: `lib/authorizationCheck.js`
- Authentication: `lib/authenticator.js`
- Configuration: `constants.js`

## License

MIT
