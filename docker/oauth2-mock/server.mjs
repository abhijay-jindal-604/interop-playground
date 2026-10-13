// Google stand-in for Mimoto's login (S-025). Mimoto registers Google as plain OAuth2
// (scope profile,email), so an OIDC-only mock cannot be used; oauth2-mock-server 9.2.0 with a
// beforeUserinfo hook returns the fixed test persona. Listens on 8095 inside playground_net;
// the BFF gateway publishes it (02 §2.3).
import { OAuth2Server } from 'oauth2-mock-server';

const server = new OAuth2Server();
await server.issuer.keys.generate('RS256');
server.service.on('beforeUserinfo', (res) => {
  res.body = {
    sub: 'asha.rao@example.org',
    email: 'asha.rao@example.org',
    email_verified: true,
    name: 'Asha Rao',
    picture: 'https://mosip.github.io/inji-config/logos/agro-vertias-logo.png',
  };
});
await server.start(8095, '0.0.0.0');
process.stdout.write(`oauth2 mock listening on ${server.issuer.url}\n`);
