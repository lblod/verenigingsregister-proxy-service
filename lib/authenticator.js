import fs from 'fs';
import path from 'path';
import glob from 'glob';
import jwt from 'jsonwebtoken';
import https from 'https';
import { randomUUID } from 'crypto';
import { CLIENT_ID, ENVIRONMENT, AUD, AUTH_DOMAIN, SCOPE, AUTHORIZATION_KEY } from '../constants.js';

class Authenticator {
  constructor() {
    this.authHealthStatus = {
      status: 'unknown',
      lastChecked: null,
      details: {},
    };
    this.cachedAuthentication = null; // Holds the last successful authentication response JSON
  }

  /**
   * Returns a valid cached access token if available, otherwise null.
   * A token is valid if it exists, has requestDateTime and expires_in,
   * and has not expired (with a 60 second margin).
   */
  getCachedToken() {
    if (
      this.cachedAuthentication?.access_token &&
      this.cachedAuthentication?.requestDateTime &&
      this.cachedAuthentication?.expires_in
    ) {
      const issuedAt =
        this.cachedAuthentication.requestDateTime instanceof Date
          ? this.cachedAuthentication.requestDateTime
          : new Date(this.cachedAuthentication.requestDateTime);
      const expiresIn = Number(this.cachedAuthentication.expires_in);
      const now = new Date();
      // 60 seconds margin
      const expiry = new Date(issuedAt.getTime() + (expiresIn - 60) * 1000);
      if (now < expiry) {
        return this.cachedAuthentication.access_token;
      }
    }
    return null;
  }

  async getAccessToken() {
    // First, try to return a valid cached token
    const cachedToken = this.getCachedToken();
    if (cachedToken) {
      return cachedToken;
    }

    // If no valid cached token, proceed to fetch a new one
    console.log('Fetching new access token...');
    if (ENVIRONMENT !== 'PROD') {
      const authorizationKey = AUTHORIZATION_KEY;
      if (!authorizationKey) {
        console.error('Error: AUTHORIZATION_KEY environment variable is not defined.');
        throw new Error('AUTHORIZATION_KEY environment variable is required but not defined.');
      }
      const url = new URL(`${AUD}/v1/token`);
      const data = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: SCOPE,
      }).toString();

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + authorizationKey,
        },
      };

      return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode === 200) {
              const responseJson = JSON.parse(body);
              responseJson.requestDateTime = new Date(); // Store as Date object, not string
              this.cachedAuthentication = responseJson; // Cache the full response
              resolve(responseJson.access_token);
            } else {
              console.error('Error:', res.statusCode);
              console.error('Error details:', JSON.stringify(body, null, 2));
              reject("failed to fetch access token: " + res.statusCode);
            }
          });
        });

        req.on('error', (error) => {
          console.error('Error:', error.message);
          console.error('Error details:', error);
          reject(null);
        });

        req.write(data);
        req.end();
      });
    } else {
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + 9 * 60; // 9 minutes from now

      const payload = {
        iss: CLIENT_ID,
        sub: CLIENT_ID,
        aud: AUD,
        exp: exp,
        jti: randomUUID(),
        iat: iat,
      };

      console.log('Payload:', payload);

      const keyTest = this.getKeyFromConfig('/config');

      if (keyTest) {
        const token = jwt.sign(payload, keyTest, { algorithm: 'RS256' });

        const url = new URL(`https://${AUTH_DOMAIN}/op/v1/token`);
        const data = new URLSearchParams({
          grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          scope: SCOPE,
          client_assertion: token,
        }).toString();

        const options = {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        };

        // Log the curl command for debugging
        const curl = `curl -X ${options.method} '${url}' -H 'Accept: application/json' -H 'Content-Type: application/x-www-form-urlencoded' -d '${data}'`;
        console.log('CURL', curl);

        return new Promise((resolve, reject) => {
          const req = https.request(url, options, (res) => {
            let body = '';
            res.on('data', (chunk) => {
              body += chunk;
            });
            res.on('end', () => {
              if (res.statusCode === 200) {
                const responseJson = JSON.parse(body);
                responseJson.requestDateTime = new Date(); // Store as Date object, not string
                this.cachedAuthentication = responseJson; // Cache the full response
                resolve(responseJson.access_token);
              } else {
                console.error('Error:', res.statusCode);
                console.error('Error details:', body);
                reject("failed to fetch access token: " + res.statusCode);
              }
            });
          });

          req.on('error', (error) => {
            console.error('Error:', error.message);
            reject(null);
          });

          req.write(data);
          req.end();
        });
      } else {
        return null;
      }
    }
  }

  getKeyFromConfig(configPath) {
    if (!fs.existsSync(configPath)) {
      console.error(`The specified directory does not exist: ${configPath}`);
      return null;
    }

    const keyFiles = glob.sync(path.join(configPath, '*.pem'));
    if (keyFiles.length === 0) {
      console.error(`No key files found in the specified directory: ${configPath}`);
      return null;
    }

    const keyFile = keyFiles[0];
    const key = fs.readFileSync(keyFile, 'utf8');
    return key;
  }
}

export { Authenticator };
