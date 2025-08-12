# Verenigingsregister Proxy Service

This service acts as a proxy for the Verenigingsregister API, handling authentication, authorization, and header management for requests to the backend API.

## Features

- Forwards requests to the Verenigingsregister API
- Removes sensitive headers before forwarding
- Handles authentication using OAuth2 access tokens
- Checks authorization for incoming requests: checks `verenigingen-beheerder` role. 
- Supports CRUD operations for verenigingen, contactgegevens, locaties, and vertegenwoordigers

## Usage

Add this to the docker-compose.override.yml (similar to the `harvesting-verenigingen-scraper-service`)

For Development (T&I API):

```
    environment:
      ENVIRONMENT: 'DEV'
      AUD: 'https://authenticatie-ti.vlaanderen.be/op'
      API_URL: 'https://iv.api.tni-vlaanderen.be/api/v1/organisaties/verenigingen/'
      AUTHORIZATION_KEY: 'your-key'
      AUT_DOMAIN: 'authenticatie-ti.vlaanderen.be'
      CLIENT_ID: 'your-client-id'
      SCOPE: 'dv_magda_organisaties_verenigingen_verenigingen_v1_G dv_magda_organisaties_verenigingen_verenigingen_v1_A dv_magda_organisaties_verenigingen_verenigingen_v1_P dv_magda_organisaties_verenigingen_verenigingen_v1_D'
```

For Production:

```
    environment:
      ENVIRONMENT: 'PROD'
      AUD: AUD: 'https://authenticatie.vlaanderen.be/op'
      CLIENT_ID: 'your-client-id'
      SCOPE: 'dv_magda_organisaties_verenigingen_verenigingen_v1_G dv_magda_organisaties_verenigingen_verenigingen_v1_A dv_magda_organisaties_verenigingen_verenigingen_v1_P dv_magda_organisaties_verenigingen_verenigingen_v1_D'
    volumes:
      - ./config/verenigingen-api-proxy:/config
```

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

## Development

- Code is organized in the `lib/` directory.
- Main entry point: `app.js`
- Router logic: `lib/verenigingenRouter.js`

## License

MIT
